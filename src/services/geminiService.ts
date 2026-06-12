import type { PackingList, Phrase, Plan } from "../types.js";
import { TtlCache } from "../utils/ttlCache.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PLAN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

  async generateTravelPlan(
    origin: string,
    destination: string,
    duration: string,
  ): Promise<Plan> {
    const cacheKey = `${origin}|${destination}|${duration}`.toLowerCase();
    const cached = this.planCache.get(cacheKey);
    if (cached) return cached;

    const prompt = `Act as "go Nomad", an elite travel architect. Create a comprehensive vacation plan.
    Origin: ${origin}, Destination: ${destination}, Duration: ${duration} days.

    CRITICAL RULES:
    1. **Destination Label:** ALWAYS return "Primary City, Country" — NEVER repeat the same name on both sides of the comma. If input is a City (e.g. "Aleppo"), return "Aleppo, Syria". If input is a Country (e.g. "England"), return its capital or primary tourist/arrival city plus the country, e.g. "London, UK" or "Nairobi, Kenya" — NOT "England, UK" or "Kenya, Kenya".
    2. **Arrival Hub:** If destination is a Country, suggest the best city/airport to land (e.g. "Land in London Heathrow"). This city must match the city used in the "header" label from Rule 1.
    3. **Airlines & Map:** - Return valid flight routes.
       - LIST AT LEAST 15 DIFFERENT AIRLINES servicing this route, start with local then regional then international as it applies.
       - Airlines 'must' be operating in the country of 'origin' (i.e have operating license in the country of origin) and can be any location in the country of origin provided that they 'operate' and 'offer routes' to and from the country of Origin.
       - Airlines displayed 'must' have 'operational routes' from the country of origin to destination and can be either direct or through connecting hubs, code shares and partnership with other airlines.
       - Include 'route' string with Airport Codes & Country (e.g. "JFK (USA) -> LHR (UK) -> DXB (UAE)").
       - **Stops:** Include 'stops' array for ALL layovers (can be 0, 1, 2 or more stops). For EACH stop, provide 'city', 'coords' [lat, lon], 'activity' (micro-adventure), and 'conditions' (visa/time reqs for entering country during layover).
       - **Coords:** Provide 'originCoords' as the specific [lat, lon] of the Origin Airport matching THIS airline's 'originCity', and 'destCoords' as the [lat, lon] of the Destination Airport THIS airline lands at.
       - **Coordinate Accuracy (CRITICAL):** Every coordinate pair ('coords', 'originCoords', 'destCoords', and stop 'coords') MUST be the true, real-world location of the named city/airport. Double-check the latitude/longitude against the actual place — do NOT confuse cities that sound alike or share letters in their airport codes (e.g. Nairobi, Kenya [~-1.29, 36.82] is NOT Narita, Japan [~35.76, 140.39]; these are on opposite hemispheres). A 'city' name paired with coordinates from a different country is a critical error and must never happen.
       - **Origin Cities (Multi-City Departure):** If the origin "${origin}" is a Country rather than a single city, identify the 2-3 major cities/airports in that country with international departures toward the destination (e.g. for Nigeria: "Lagos, Nigeria" (LOS) and "Abuja, Nigeria" (ABV)). For EVERY airline entry, set 'originCity' to the specific "City, Country" it departs from, and ensure the full airlines list collectively covers ALL identified origin cities, each with realistic, independently-priced 'prices' (prices should vary by origin city where realistic, e.g. Lagos may be cheaper than Abuja for the same airline). If origin is already a single city, set 'originCity' to that same city for every airline.
    4. **Visa Status:** Be specific (e.g., "Visa Free", "Visa on Arrival", "Schengen Visa Required").
    5. **Airbnb:** Ensure 'stays' includes at least five Airbnb and Five Hotel option with the 'cheapest' stays displayed.
    6. **Alternates:** Activities must have at least 3 'alt' (indoor/relaxed/outdoor option) and itemised.
    7. **Guides:** Include 'tourGuides' with contact info.
    8. **Culture:** Include 'unescoSites' (array) if applicable, and a 'funFact' (string).
    9. **Consistency & Value:** Tie 'spend.breakdown.flights' to the cheapest 'economy' price found in 'airlines', and 'spend.breakdown.stay' to the cheapest applicable item in 'stays' for the full trip duration. Order BOTH the 'airlines' array and the 'stays' array with the CHEAPEST option FIRST, so the best-value choice is immediately obvious.
    10. **Visa (best effort):** Fill in 'visa' with your best current knowledge of the policy between the origin and destination countries — a separate, up-to-date lookup may refine this afterwards, so this is just a sensible starting point.

    Output ONLY JSON: {
      "header": "City, Country", "arrivalHub": "Best Landing Hub",
      "coords": { "origin": [lat, lon], "dest": [lat, lon] },
      "airlines": [{ "name": "Airline Name", "type": "Direct/1 Stop", "route": "Full path string", "hub": "Hub City", "originCity": "Departure City, Country", "originCoords": [lat, lon], "destCoords": [lat, lon], "prices": { "economy": "$", "business": "$", "first": "$" }, "stops": [{ "city": "Hub", "coords": [lat, lon], "activity": "Activity", "conditions": "Visa/Time info" }] }],
      "bestTime": "Season & Why",
      "visa": { "status": "Specific Status", "reqs": ["List 2-3"], "checklist": ["List 2-3"] },
      "spend": { "total": "$Range", "breakdown": { "flights": "$", "visa": "$", "stay": "$", "daily": "$", "transport": "$" } },
      "tourGuides": [{ "name": "", "specialty": "", "contact": "", "price": "$" }],
      "unescoSites": ["Site 1", "Site 2"],
      "funFact": "Interesting unique fact about the place.",
      "itinerary": [{ "day": 1, "title": "", "activities": [{ "main": "", "alt": "" }], "meal": "" }],
      "stays": [{ "type": "Airbnb/Hotel", "name": "", "price": "", "desc": "" }],
      "tips": []
    }`;

    const [planResult, visaResult] = await Promise.allSettled([
      this.generateJson<Plan>(prompt, { temperature: 0.15 }),
      this.generateVisaInfo(origin, destination),
    ]);

    if (planResult.status === "rejected") {
      throw planResult.reason;
    }

    const plan = planResult.value;
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
