import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { GeminiService } from "./services/geminiService.js";
import { travelRoutes } from "./routes/travel.js";

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      config.nodeEnv === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
  },
});
const gemini = new GeminiService(
  config.geminiApiKey,
  config.geminiModel,
  config.geminiFallbackModel,
);

await app.register(cors, { origin: config.corsOrigin });

app.get("/health", async () => ({ status: "ok" }));

await travelRoutes(app, gemini);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
