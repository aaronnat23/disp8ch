import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  ZHIPU_API_KEY: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  QWEN_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  WHATSAPP_AUTO_CONNECT: z.string().optional(),
  WS_PORT: z.coerce.number().default(3101),
  DATABASE_PATH: z.string().default("./data/disp8ch.db"),
  MEMORY_PATH: z.string().default("./data/memories"),
  ENCRYPTION_KEY: z.string().optional(),
  SECRETS_MASTER_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  cachedEnv = envSchema.parse(process.env);
  return cachedEnv;
}
