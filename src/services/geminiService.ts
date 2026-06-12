import type { PackingList, Phrase, Plan } from "../types.js";
import { TtlCache } from "../utils/ttlCache.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PLAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Logistics half of the plan — flights, costs, visa, map data. Generated in parallel with {@link ExtrasPlan}. */
type CorePlan = Pick<
  Plan,
  "header" | "arrivalHub" | "arrivalAirport" | "coords" | "airlines" | "bestTime" | "visa" | "spend"
>;

/** Experience half of the plan — itinerary, stays, guides, culture. Generated in parallel with {@link CorePlan}. */
type ExtrasPlan = Pick<
  Plan,
  "tourGuides" | "unescoSites" | "funFact" | "itinerary" | "stays" | "tips"
>;

/** Fallback when the extras call fails — keeps the core (flights/visa/cost) plan usable. */
const EMPTY_EXTRAS: ExtrasPlan = {
  tourGuides: [],
  unescoSites: [],
  funFact: "",
  itinerary: [],
  stays: [],
  tips: [],
};

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface GenerateOptions {
  temperature?: number;
  /** Enables Google Search grounding for up-to-date info (e.g. visa rules, pricing). */
  grounded?: boolean;
}

function extractJson(text: string): string {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) return cleaned;
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  return end === -1 ? cleaned : cleaned.slice(start, end + 1);
}

/** HTTP statuses where the model is temporarily unavailable/overloaded — worth retrying on a fallback model. */
const RETRYABLE_STATUSES = new Set([429, 503]);
/** Brief pause before a last-resort retry, giving a transient "high demand" 503 a chance to clear. */
const RETRY_DELAY_MS = 3000;

class GeminiHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Gemini request failed: ${status}`);
  }
}

export class GeminiService {
  private readonly planCache = new TtlCache<Plan>(PLAN_CACHE_TTL_MS);

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fallbackModel?: string,
    private readonly openaiApiKey?: string,
    private readonly openaiModel: string = "gpt-5.4-mini-2026-03-17",
  ) {}

  private async requestModel(
    model: string,
    prompt: string,
    options: GenerateOptions,
  ): Promise<string> {
    const { temperature = 0.3, grounded = false } = options;

    const generationConfig: Record<string, unknown> = { temperature };
    // Google Search grounding and forced JSON response mime type are mutually exclusive.
    if (!grounded) {
      generationConfig.responseMimeType = "application/json";
    }

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    };
    if (grounded) {
      body.tools = [{ googleSearch: {} }];
    }

    const response = await fetch(
      `${GEMINI_BASE_URL}/${model}:generateContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new GeminiHttpError(response.status);
    }

    const result = (await response.json()) as GeminiResponse;
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Gemini returned no content");
    }

    return text;
  }

  private async generateJson<T>(prompt: string, options: GenerateOptions = {}): Promise<T> {
    try {
      return await this.generateJsonGemini<T>(prompt, options);
    } catch (err) {
      if (!this.openaiApiKey) {
        throw err;
      }

      const status = err instanceof GeminiHttpError ? err.status : undefined;
      console.warn(
        `Gemini unavailable (${status ?? err}), falling back to OpenAI "${this.openaiModel}"`,
      );
      try {
        const text = await this.requestOpenAi(prompt, options);
        return JSON.parse(extractJson(text)) as T;
      } catch (openaiErr) {
        console.warn("OpenAI fallback also failed:", openaiErr);
        throw err;
      }
    }
  }

  private async generateJsonGemini<T>(prompt: string, options: GenerateOptions = {}): Promise<T> {
    const models = [this.model, this.fallbackModel].filter(
      (model, index, all): model is string => !!model && all.indexOf(model) === index,
    );

    for (let i = 0; i < models.length; i++) {
      try {
        const text = await this.requestModel(models[i], prompt, options);
        return JSON.parse(extractJson(text)) as T;
      } catch (err) {
        const status = err instanceof GeminiHttpError ? err.status : undefined;
        if (!status || !RETRYABLE_STATUSES.has(status)) throw err;

        if (i < models.length - 1) {
          console.warn(
            `Gemini model "${models[i]}" returned ${status}, retrying with fallback "${models[i + 1]}"`,
          );
          continue;
        }

        // Last model also hit a transient capacity error — give the API a moment and retry once more.
        console.warn(
          `Gemini model "${models[i]}" returned ${status}, retrying once after a short delay`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        const text = await this.requestModel(models[i], prompt, options);
        return JSON.parse(extractJson(text)) as T;
      }
    }

    throw new Error("Gemini request failed: no models configured");
  }

  /** Last-resort fallback when Gemini is rate-limited/unavailable on all configured models. */
  private async requestOpenAi(prompt: string, options: GenerateOptions): Promise<string> {
    const { grounded = false } = options;

    // Mirrors Gemini's Google Search grounding: route through the Responses API's
    // web_search tool so up-to-date queries (e.g. visa rules) use live web context
    // rather than the model's training data.
    if (grounded) {
      return this.requestOpenAiWebSearch(prompt);
    }

    // No `temperature` override: newer reasoning models (e.g. gpt-5.x) only
    // support the default value and error on any other value.
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: this.openaiModel,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = result.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("OpenAI returned no content");
    }

    return text;
  }

  /** Grounded OpenAI fallback — Responses API with the built-in web_search tool. */
  private async requestOpenAiWebSearch(prompt: string): Promise<string> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: this.openaiModel,
        input: prompt,
        tools: [{ type: "web_search" }],
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = result.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .find((c) => c.type === "output_text")?.text;

    if (!text) {
      throw new Error("OpenAI returned no content");
    }

    return text;
  }

  async generateTravelPlan(
    origin: string,
    destination: string,
    duration: string,
  ): Promise<Plan> {
    const cacheKey = `${origin}|${destination}|${duration}`.toLowerCase();
    const cached = this.planCache.get(cacheKey);
    if (cached) return cached;

    const corePrompt = `Act as "go Nomad", an elite travel architect. Create the CORE logistics for a vacation plan.
    Origin: ${origin}, Destination: ${destination}, Duration: ${duration} days.

    CRITICAL RULES:
    1. **Destination Label:** ALWAYS return "Primary City, Country" — NEVER repeat the same name on both sides of the comma. If input is a City (e.g. "Aleppo"), return "Aleppo, Syria". If input is a Country (e.g. "England"), return its capital or primary tourist/arrival city plus the country, e.g. "London, UK" or "Nairobi, Kenya" — NOT "England, UK" or "Kenya, Kenya".
    2. **Origin Cities (Multi-City Departure) — MANDATORY, applies to almost every country:** First decide whether "${origin}" is already a single city, or a country/region.
       - If "${origin}" is a COUNTRY: pick the 2-3 cities within it that have the busiest international airports with routes toward "${destination}" — almost every country has at least 2 (e.g. Nigeria: "Lagos, Nigeria" (LOS) + "Abuja, Nigeria" (ABV); USA: "New York, USA" (JFK) + "Los Angeles, USA" (LAX); UK: "London, UK" (LHR) + "Manchester, UK" (MAN); India: "Delhi, India" (DEL) + "Mumbai, India" (BOM)). The full 'airlines' array's 'originCity' values MUST collectively include ALL of these cities — do NOT set every airline's 'originCity' to the same single city. Only use ONE 'originCity' for every airline if "${origin}" is a small nation/city-state genuinely served by a single international airport (e.g. Singapore, Malta, Luxembourg).
       - If "${origin}" is already a single CITY, set 'originCity' to that same "City, Country" for every airline.
       - Each distinct 'originCity' needs its own realistic, independently-priced 'prices' (vary plausibly by city, e.g. a secondary hub may be cheaper or pricier than the capital depending on competition).
    3. **Arrival Hub & Airport:** If destination "${destination}" is a Country, identify the best city to land in (its capital or primary tourist/arrival hub) and set 'arrivalHub' to a short phrase like "Land in <City>". If destination is already a specific city (e.g. "São Paulo"), 'arrivalHub' MUST be that SAME city — do NOT redirect to a different city or the country's capital (e.g. destination "São Paulo, Brazil" must land in São Paulo, NOT Rio de Janeiro or Brasília). Set 'arrivalAirport' to the full official name + IATA code of the main international airport serving that city (e.g. "São Paulo–Guarulhos International Airport (GRU)", "Hamad International Airport (DOH)"). The city named in "header" (Rule 1), "arrivalHub", and "coords.dest" MUST all refer to the SAME city/airport — "coords.dest" must be the true geographic location of "arrivalAirport".
    4. **Airlines & Map:** - Return valid flight routes.
       - LIST AT LEAST 15 DIFFERENT AIRLINES servicing this route, start with local then regional then international as it applies.
       - Airlines 'must' be operating in the country of 'origin' (i.e have operating license in the country of origin) and can be any location in the country of origin provided that they 'operate' and 'offer routes' to and from the country of Origin.
       - Airlines displayed 'must' have 'operational routes' from the country of origin to destination and can be either direct or through connecting hubs, code shares and partnership with other airlines.
       - Include 'route' string with Airport Codes & Country (e.g. "JFK (USA) -> LHR (UK) -> DXB (UAE)").
       - **Stops:** Include 'stops' array for ALL layovers (can be 0, 1, 2 or more stops). For EACH stop, provide 'city', 'airport' (full official name + IATA code of the layover airport, e.g. "Hamad International Airport (DOH)"), 'coords' [lat, lon] of THAT AIRPORT, 'activity' (micro-adventure), and 'conditions' (visa/time reqs for entering country during layover).
       - **Coords & Airports:** Provide 'originCoords' as the specific [lat, lon] of the Origin Airport matching THIS airline's 'originCity' (per Rule 2), with 'originAirport' as that airport's full name + IATA code; and 'destCoords'/'destAirport' as the [lat, lon] and full name + IATA code of the Destination Airport THIS airline lands at (this may match the overall "arrivalAirport" from Rule 3, or be a different airport serving the same metro area).
       - **Coordinate Accuracy (CRITICAL):** Every coordinate pair ('coords', 'originCoords', 'destCoords', and stop 'coords') MUST be the true, real-world location of the named airport/city — airport-level precision, not just the city center, when they differ. Double-check the latitude/longitude against the actual place — do NOT confuse cities that sound alike or share letters in their airport codes (e.g. Nairobi, Kenya [~-1.29, 36.82] is NOT Narita, Japan [~35.76, 140.39]; these are on opposite hemispheres). A 'city'/'airport' name paired with coordinates from a different country is a critical error and must never happen.
    5. **Visa Status:** Be specific (e.g., "Visa Free", "Visa on Arrival", "Schengen Visa Required").
    6. **Consistency & Value:** Tie 'spend.breakdown.flights' to the cheapest 'economy' price found in 'airlines'. Order the 'airlines' array with the CHEAPEST option FIRST, so the best-value choice is immediately obvious.
    7. **Visa (best effort):** Fill in 'visa' with your best current knowledge of the policy between the origin and destination countries — a separate, up-to-date lookup may refine this afterwards, so this is just a sensible starting point.

    Output ONLY JSON: {
      "header": "City, Country", "arrivalHub": "Best Landing Hub", "arrivalAirport": "Full Airport Name (CODE)",
      "coords": { "origin": [lat, lon], "dest": [lat, lon] },
      "airlines": [{ "name": "Airline Name", "type": "Direct/1 Stop", "route": "Full path string", "hub": "Hub City", "originCity": "Departure City, Country", "originAirport": "Full Airport Name (CODE)", "originCoords": [lat, lon], "destAirport": "Full Airport Name (CODE)", "destCoords": [lat, lon], "prices": { "economy": "$", "business": "$", "first": "$" }, "stops": [{ "city": "Hub", "airport": "Full Airport Name (CODE)", "coords": [lat, lon], "activity": "Activity", "conditions": "Visa/Time info" }] }],
      "bestTime": "Season & Why",
      "visa": { "status": "Specific Status", "reqs": ["List 2-3"], "checklist": ["List 2-3"] },
      "spend": { "total": "$Range", "breakdown": { "flights": "$", "visa": "$", "stay": "$", "daily": "$", "transport": "$" } }
    }`;

    const extrasPrompt = `Act as "go Nomad", an elite travel architect. Create the EXPERIENCE details for a vacation plan.
    Origin: ${origin}, Destination: ${destination}, Duration: ${duration} days.

    CRITICAL RULES:
    1. **Where to plan around:** If destination "${destination}" is a Country, plan around its capital or primary tourist/arrival city (e.g. for "Brazil" use a major hub like São Paulo or Rio de Janeiro). If it's already a specific city (e.g. "São Paulo"), plan around that EXACT city — do not substitute a different city or the country's capital.
    2. **Itinerary:** Provide a day-by-day itinerary for all ${duration} days. Each day needs a 'title' and 'activities' array; each activity must have a 'main' option plus at least 3 'alt' (indoor/relaxed/outdoor) options, itemised, plus a 'meal' suggestion.
    3. **Stays:** Ensure 'stays' includes at least five Airbnb and five Hotel options. Order the 'stays' array with the CHEAPEST option FIRST.
    4. **Guides:** Include 'tourGuides' with contact info and rates.
    5. **Culture:** Include 'unescoSites' (array, if applicable), and a 'funFact' (string).
    6. **Tips:** Include practical 'tips' for a traveler from "${origin}" visiting this destination.

    Output ONLY JSON: {
      "tourGuides": [{ "name": "", "specialty": "", "contact": "", "price": "$" }],
      "unescoSites": ["Site 1", "Site 2"],
      "funFact": "Interesting unique fact about the place.",
      "itinerary": [{ "day": 1, "title": "", "activities": [{ "main": "", "alt": "" }], "meal": "" }],
      "stays": [{ "type": "Airbnb/Hotel", "name": "", "price": "", "desc": "" }],
      "tips": []
    }`;

    const [coreResult, extrasResult, visaResult] = await Promise.allSettled([
      this.generateJson<CorePlan>(corePrompt, { temperature: 0.15 }),
      this.generateJson<ExtrasPlan>(extrasPrompt, { temperature: 0.3 }),
      this.generateVisaInfo(origin, destination),
    ]);

    if (coreResult.status === "rejected") {
      throw coreResult.reason;
    }

    if (extrasResult.status === "rejected") {
      console.warn("Extras generation failed, using empty fallback:", extrasResult.reason);
    }
    const extras = extrasResult.status === "fulfilled" ? extrasResult.value : EMPTY_EXTRAS;

    const plan: Plan = { ...coreResult.value, ...extras };
    if (visaResult.status === "fulfilled") {
      plan.visa = visaResult.value;
    } else {
      console.warn("Visa lookup failed, using plan's best-effort visa info:", visaResult.reason);
    }

    this.planCache.set(cacheKey, plan);
    return plan;
  }

  /** Small, dedicated, grounded lookup so the up-to-date visa check doesn't slow down or block the whole plan. */
  private async generateVisaInfo(origin: string, destination: string): Promise<Plan["visa"]> {
    const prompt = `Using up-to-date web information (current as of today), determine the CURRENT visa policy for a citizen of "${origin}" travelling to "${destination}". Visa-free agreements, e-visa programs and entry requirements change frequently — verify the latest rules rather than relying on outdated assumptions.

    Output ONLY JSON: { "status": "Specific Status (e.g. Visa Free, Visa on Arrival, Schengen Visa Required)", "reqs": ["List 2-3 entry requirements"], "checklist": ["List 2-3 prep checklist items"] }`;

    return this.generateJson<Plan["visa"]>(prompt, { temperature: 0.1, grounded: true });
  }

  async generatePackingList(
    destination: string,
    duration: string,
    bestTime: string,
  ): Promise<PackingList> {
    const prompt = `Generate a packing list for ${duration} days in ${destination}. Weather context: ${bestTime}. Output JSON: { "essentials": ["Passport", "Wallet"], "clothes": ["Item 1"], "gadgets": ["Adapter"] }`;
    return this.generateJson<PackingList>(prompt);
  }

  async generatePhrases(destination: string): Promise<Phrase[]> {
    const prompt = `Identify the main language in ${destination} and give 5 basic phrases. Output JSON: [{ "phrase": "Hello", "local": "Hola", "pron": "oh-lah" }]`;
    return this.generateJson<Phrase[]>(prompt);
  }
}
