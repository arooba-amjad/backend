import jwt from "jsonwebtoken";
import { supabase } from "../config/supabaseClient.js";

const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET;

const ensureJwtSecret = () => {
  if (!JWT_SECRET) {
    throw new Error(
      "JWT secret is not configured. Set JWT_SECRET (or SUPABASE_JWT_SECRET)."
    );
  }

  return JWT_SECRET;
};

export const protect = async (req, res, next) => {
  console.log(`\n[PROTECT MIDDLEWARE] ${req.method} ${req.path}`);
  try {
    let token = null;

    if (req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      console.log("[PROTECT] No token found");
      return res.status(401).json({ message: "Not authorized, token missing" });
    }

    const decoded = jwt.verify(token, ensureJwtSecret());
    console.log("[PROTECT] Token decoded, user ID:", decoded.id);

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, email, role, student_id, course_id, status, metadata")
      .eq("id", decoded.id)
      .maybeSingle();

    if (error) {
      console.error("[PROTECT] Auth lookup error:", error);
      return res.status(401).json({ message: "Not authorized" });
    }

    if (!user) {
      console.log("[PROTECT] User not found in database");
      return res.status(401).json({ message: "User not found" });
    }

    console.log("[PROTECT] User found:", user.email, "Role:", user.role, "Student ID:", user.student_id);

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      studentId: user.student_id,
      courseId: user.course_id,
      status: user.status,
      metadata: user.metadata,
    };
    next();
  } catch (error) {
    console.error("[PROTECT] Auth error:", error.message);
    res.status(401).json({ message: "Not authorized" });
  }
};

export const authorizeRoles = (...roles) => (req, res, next) => {
  console.log(`[AUTHORIZE] Checking roles. Required: ${roles.join(", ")}, User role: ${req.user?.role}`);
  if (!roles.includes(req.user?.role)) {
    console.log(`[AUTHORIZE] Access denied. User role ${req.user?.role} not in ${roles.join(", ")}`);
    return res.status(403).json({ message: "Forbidden: insufficient role" });
  }

  console.log(`[AUTHORIZE] Access granted for ${req.user?.role}`);
  next();
};

