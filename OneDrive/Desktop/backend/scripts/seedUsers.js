import dotenv from "dotenv";
import createDefaultUsers from "../utils/createDefaultUsers.js";

dotenv.config();

const seedUsers = async () => {
  try {
    await createDefaultUsers();
    console.log("Default users seeded.");
  } catch (error) {
    console.error("Failed to seed users:", error);
  } finally {
    process.exit(0);
  }
};

seedUsers();

