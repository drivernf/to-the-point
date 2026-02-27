import "dotenv/config";
import Fastify from "fastify";
import { z } from "zod";
import { VertexAI, GenerateContentRequest } from "@google-cloud/vertexai";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-east4";
const MODEL = process.env.GOOGLE_CLOUD_MODEL || "gemini-2.5-flash";
const TEMPERATURE = Number(process.env.GOOGLE_CLOUD_TEMPERATURE) || 0.2;

const SYSTEM = "You are a helpful assistant that answers like a pirate."

if (!PROJECT) throw new Error("Missing GOOGLE_CLOUD_PROJECT");
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON)");
}

const ai = new VertexAI({
  project: PROJECT,
  location: LOCATION,
});

const model = ai.getGenerativeModel({
  model: MODEL,
  systemInstruction: {
    role: "system",
    parts: [{ text: SYSTEM }],
  },
});

const fastify = Fastify({ logger: true });

const InferBodySchema = z.object({
  prompt: z.string().min(1),
});

fastify.post("/infer", async (req, reply) => {
  const parsed = InferBodySchema.safeParse(req.body);

  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid body", details: parsed.error.issues });
  }

  const {
    prompt,
  } = parsed.data;

  try {
    const request: GenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],

      generationConfig: {
        temperature: TEMPERATURE,
      }
    };

    const resp = await model.generateContent(request);

    return reply.send({
      output_text: resp.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
    });
  } catch (err: any) {
    req.log.error({ err }, "Gemini inference failed");

    return reply.code(502).send({
      error: "Gemini inference failed",
      message: err?.message ?? "Unknown error",
    });
  }
});

const port = Number(process.env.PORT || 3000);
await fastify.listen({ port, host: "0.0.0.0" });