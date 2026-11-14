import mongoose from "mongoose";
import { env } from "../env";

export async function connectDB(): Promise<void> {
  await mongoose
    .connect(env.MONGODB_URI, { autoIndex: env.NODE_ENV !== "production" })
    .then(() => console.log("[db] connected to MongoDB"))
    .catch((err) => {
      console.error("[db] connection failed:", err);
      process.exit(1);
    });
}
