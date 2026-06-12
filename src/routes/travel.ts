import type { FastifyInstance } from "fastify";
import type { GeminiService } from "../services/geminiService.js";

export async function travelRoutes(
  app: FastifyInstance,
  gemini: GeminiService,
) {
  app.post<{
    Body: { origin: string; destination: string; duration: string };
  }>(
    "/api/plan",
    {
      schema: {
        body: {
          type: "object",
          required: ["origin", "destination", "duration"],
          properties: {
            origin: { type: "string", minLength: 1 },
            destination: { type: "string", minLength: 1 },
            duration: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { origin, destination, duration } = request.body;
      try {
        return await gemini.generateTravelPlan(origin, destination, duration);
      } catch (err) {
        request.log.error(err);
        return reply.code(502).send({ error: "Failed to generate travel plan" });
      }
    },
  );

  app.post<{
    Body: { origin: string; destinations: string[]; duration: string };
  }>(
    "/api/compare",
    {
      schema: {
        body: {
          type: "object",
          required: ["origin", "destinations", "duration"],
          properties: {
            origin: { type: "string", minLength: 1 },
            destinations: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 2,
              maxItems: 3,
            },
            duration: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const { origin, destinations, duration } = request.body;
      const results = await Promise.all(
        destinations.map(async (destination) => {
          try {
            const plan = await gemini.generateTravelPlan(origin, destination, duration);
            return { destination, plan };
          } catch (err) {
            request.log.error(err);
            return { destination, plan: null, error: "Failed to generate plan" };
          }
        }),
      );
      return { results };
    },
  );

  app.post<{
    Body: { destination: string; duration: string; bestTime: string };
  }>(
    "/api/packing",
    {
      schema: {
        body: {
          type: "object",
          required: ["destination", "duration", "bestTime"],
          properties: {
            destination: { type: "string", minLength: 1 },
            duration: { type: "string", minLength: 1 },
            bestTime: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { destination, duration, bestTime } = request.body;
      try {
        return await gemini.generatePackingList(destination, duration, bestTime);
      } catch (err) {
        request.log.error(err);
        return reply.code(502).send({ error: "Failed to generate packing list" });
      }
    },
  );

  app.post<{ Body: { destination: string } }>(
    "/api/phrases",
    {
      schema: {
        body: {
          type: "object",
          required: ["destination"],
          properties: {
            destination: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { destination } = request.body;
      try {
        return await gemini.generatePhrases(destination);
      } catch (err) {
        request.log.error(err);
        return reply.code(502).send({ error: "Failed to generate phrases" });
      }
    },
  );
}
