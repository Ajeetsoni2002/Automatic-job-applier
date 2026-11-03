import mongoose from 'mongoose';
import { getEnv } from './env.js';
import { logger } from './logger.js';

export async function connectDb(uri: string = getEnv().MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.debug({ db: mongoose.connection.name }, 'mongodb connected');
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
