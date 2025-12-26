import bcrypt from "bcryptjs";
import { supabase } from "../config/supabaseClient.js";

const defaultUsers = [
  {
    name: "Portal Administrator",
    email: "admin@ataitcourses.com",
    role: "admin",
    password: "Bismillah786",
    resetPassword: true,
  },
  {
    name: "Web Development Instructor",
    email: "web.dev@teacherportal.com",
    role: "teacher",
    password: "Atacourses342",
    resetPassword: true,
    metadata: { subject: "Web Development" },
  },
  {
    name: "ATA Student",
    email: "student@portal.com",
    role: "student",
    password: "student@portal",
    resetPassword: true,
    studentId: "STUATA001",
  },
];

const createOrUpdateUser = async (user) => {
  const identifierColumn =
    user.role === "student" && user.studentId ? "student_id" : "email";
  const identifierValue =
    identifierColumn === "student_id"
      ? user.studentId.toUpperCase()
      : user.email.toLowerCase();

  const { data: existing, error: fetchError } = await supabase
    .from("users")
    .select("id, password_hash")
    .eq(identifierColumn, identifierValue)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  const payload = {
    name: user.name,
    email: user.email.toLowerCase(),
    role: user.role,
    status: "Active",
    student_id: user.studentId ? user.studentId.toUpperCase() : null,
    metadata: user.metadata || {},
  };

  if (existing) {
    const updates = { ...payload };

    if (user.resetPassword === true && user.password) {
      updates.password_hash = await bcrypt.hash(user.password, 10);
    }

    if (updates.password_hash === undefined) {
      delete updates.password_hash;
    }

    await supabase
      .from("users")
      .update(updates)
      .eq("id", existing.id);
    console.log(`Default ${user.role} account ensured for ${user.email}`);
  } else {
    const hashedPassword = await bcrypt.hash(user.password, 10);
    await supabase.from("users").insert({
      ...payload,
      password_hash: hashedPassword,
    });
    console.log(`Default ${user.role} account created for ${user.email}`);
  }
};

const createDefaultUsers = async () => {
  if (process.env.SEED_DEFAULT_USERS === "false") {
    console.log("Skipping default user creation (SEED_DEFAULT_USERS=false)");
    return;
  }

  try {
    console.log("Creating/updating default users...");
    for (const user of defaultUsers) {
      try {
        await createOrUpdateUser(user);
      } catch (error) {
        console.error(`Failed to create/update user ${user.email}:`, error.message);
        // Continue with other users even if one fails
      }
    }
    console.log("Default users check completed.");
  } catch (error) {
    console.error("Error in createDefaultUsers:", error.message);
    // Don't throw - allow server to start even if user creation fails
    console.warn("Server will continue to start, but default users may not be available.");
  }
};

export default createDefaultUsers;

