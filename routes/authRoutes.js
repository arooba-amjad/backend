import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabaseClient.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET;
const ADMIN_ROLES = ["admin", "super_admin", "co_admin"];

const ensureJwtSecret = () => {
  if (!JWT_SECRET) {
    throw new Error(
      "JWT secret is not configured. Set JWT_SECRET (or SUPABASE_JWT_SECRET)."
    );
  }
};

const generateToken = (id, role) => {
  ensureJwtSecret();
  return jwt.sign({ id, role }, JWT_SECRET, {
    expiresIn: "7d",
  });
};

const recordAdminLogin = async (req, adminId) => {
  try {
    const ipHeader = req.headers["x-forwarded-for"];
    const ip =
      (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader?.split(",")?.[0]) ||
      req.socket?.remoteAddress ||
      req.ip ||
      null;

    const userAgent =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : Array.isArray(req.headers["user-agent"])
        ? req.headers["user-agent"][0]
        : null;

    const { error } = await supabase.from("admin_activity_logs").insert({
      admin_id: adminId,
      event_type: "login",
      ip_address: ip,
      user_agent: userAgent,
      metadata: {
        forwardedFor: ipHeader || null,
      },
    });

    if (error) {
      // Log but don't throw - activity logging is non-critical
      console.warn("Failed to log admin activity (non-critical):", error.message);
    }
  } catch (error) {
    // Log but don't throw - activity logging should not break login
    console.warn("Error in recordAdminLogin (non-critical):", error.message);
  }
};

// Generate random password
const generatePassword = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@#$%^&*";
  const length = 12;
  let password = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    password += chars[randomIndex];
  }
  return password;
};

// Generate unique student ID
const generateStudentId = async () => {
  let studentId;
  let exists = true;
  while (exists) {
    const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
    studentId = `STU${randomPart}`;
    const { data } = await supabase
      .from("users")
      .select("id")
      .eq("student_id", studentId)
      .maybeSingle();
    exists = !!data;
  }
  return studentId;
};

// Map enrollment course ID to database course
const mapEnrollmentCourseToDbCourse = async (enrollmentCourseId) => {
  const courseNameMap = {
    '1': 'WEB DEVELOPMENT',
    '2': 'APP DEVELOPMENT',
    '3': 'UI/UX',
    '4': 'DIGITAL MARKETING AND SEO',
    '5': 'CYBERSECURITY',
    '6': 'MACHINE LEARNING',
  };

  const courseName = courseNameMap[enrollmentCourseId];
  if (!courseName) {
    return null;
  }

  // Find course by name (case-insensitive)
  // Try exact match first, then case-insensitive
  let { data: course, error } = await supabase
    .from("courses")
    .select("id, name")
    .eq("name", courseName)
    .maybeSingle();

  // If not found, try case-insensitive search
  if (!course && !error) {
    const { data: allCourses } = await supabase
      .from("courses")
      .select("id, name");
    
    if (allCourses) {
      course = allCourses.find(c => c.name?.toUpperCase() === courseName.toUpperCase()) || null;
    }
  }

  if (error) {
    console.error("Error finding course:", error);
    return null;
  }

  return course;
};

// POST /auth/enroll - Public enrollment endpoint
router.post("/enroll", async (req, res) => {
  try {
    const { fullName, email, phone, courseId, dateOfBirth } = req.body;

    // Validation
    if (!fullName || !email || !phone || !courseId) {
      return res.status(400).json({
        message: "Full name, email, phone, and course selection are required",
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists in users table
    const { data: existingUser, error: checkError } = await supabase
      .from("users")
      .select("id, email, role")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (checkError) {
      console.error("Error checking existing user:", checkError);
      throw checkError;
    }

    if (existingUser) {
      return res.status(400).json({
        message: "An account with this email already exists. Please log in instead.",
      });
    }

    // Check if email already exists in pending enrollments
    const { data: existingEnrollment, error: enrollmentCheckError } = await supabase
      .from("course_students")
      .select("student_email")
      .eq("student_email", normalizedEmail)
      .is("student_id", null)
      .maybeSingle();

    if (enrollmentCheckError) {
      console.error("Error checking existing enrollment:", enrollmentCheckError);
      throw enrollmentCheckError;
    }

    if (existingEnrollment) {
      return res.status(400).json({
        message: "You have already enrolled with this email. Please wait for admin approval.",
      });
    }

    // Map enrollment course ID to database course
    const course = await mapEnrollmentCourseToDbCourse(courseId);
    if (!course) {
      return res.status(400).json({
        message: "Selected course not found. Please select a valid course.",
      });
    }

    // Create enrollment record WITHOUT creating user account
    // student_id will be NULL until admin creates the student account
    const { error: enrollmentError } = await supabase
      .from("course_students")
      .insert({
        course_id: course.id,
        student_id: null, // NULL means enrollment pending
        student_name: fullName.trim(),
        student_email: normalizedEmail,
        student_phone: phone.trim(),
        course_name: course.name,
      });

    if (enrollmentError) {
      console.error("Error creating enrollment:", enrollmentError);
      throw enrollmentError;
    }

    // Return success response
    res.status(201).json({
      success: true,
      message: "Enrollment submitted successfully! Your account will be created by an administrator. You will receive your Student ID and Password via email once your account is approved.",
    });
  } catch (error) {
    console.error("Enrollment error:", error);
    res.status(500).json({
      message: error.message || "Enrollment failed. Please try again.",
    });
  }
});

// POST /auth/forgot-password - Request password reset
router.post("/forgot-password", async (req, res) => {
  try {
    const { identifier, email } = req.body;
    const loginId = identifier || email;

    if (!loginId) {
      return res.status(400).json({ message: "Email or Student ID is required" });
    }

    const normalizedId = loginId.trim();

    // Find user by email or student_id
    const query = supabase.from("users").select("id, email, name, student_id, role").limit(1);

    const { data: rows, error } = normalizedId.includes("@")
      ? await query.eq("email", normalizedId.toLowerCase())
      : await query.or(
          `student_id.eq.${normalizedId.toUpperCase()},email.eq.${normalizedId.toLowerCase()}`
        );

    if (error) {
      console.error("Forgot password lookup error:", error);
      // Don't reveal if user exists or not for security
      return res.json({
        message: "If an account exists with this identifier, a password reset link has been sent.",
      });
    }

    const user = rows?.[0];

    // Don't reveal if user exists or not for security
    if (!user) {
      return res.json({
        message: "If an account exists with this identifier, a password reset link has been sent.",
      });
    }

    // Generate reset token (6-digit code for simplicity, or UUID for link-based)
    const resetToken = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Token expires in 1 hour

    // Hash the token before storing
    const hashedToken = await bcrypt.hash(resetToken, 10);

    // Store reset token in database
    // We'll use a password_reset_tokens table or store in user metadata
    const { error: tokenError } = await supabase
      .from("users")
      .update({
        metadata: {
          ...(user.metadata || {}),
          password_reset_token: hashedToken,
          password_reset_expires: expiresAt.toISOString(),
        },
      })
      .eq("id", user.id);

    if (tokenError) {
      console.error("Error storing reset token:", tokenError);
      return res.status(500).json({ message: "Server error. Please try again." });
    }

    // In production, send email here
    // For now, return the token in development mode (remove in production!)
    const response = {
      message: "Password reset code has been generated.",
      // Only include token in development - REMOVE IN PRODUCTION!
      ...(process.env.NODE_ENV === "development" && {
        resetToken,
        expiresAt: expiresAt.toISOString(),
        warning: "This token is only shown in development mode. In production, it will be sent via email.",
      }),
    };

    console.log(`[PASSWORD RESET] Token generated for user ${user.email}: ${resetToken} (expires: ${expiresAt.toISOString()})`);

    res.json(response);
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ message: "Server error. Please try again." });
  }
});

// POST /auth/reset-password - Reset password with token
router.post("/reset-password", async (req, res) => {
  try {
    const { identifier, resetToken, newPassword } = req.body;

    if (!identifier || !resetToken || !newPassword) {
      return res.status(400).json({
        message: "Identifier, reset token, and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters long",
      });
    }

    const normalizedId = identifier.trim();

    // Find user
    const query = supabase.from("users").select("*").limit(1);

    const { data: rows, error } = normalizedId.includes("@")
      ? await query.eq("email", normalizedId.toLowerCase())
      : await query.or(
          `student_id.eq.${normalizedId.toUpperCase()},email.eq.${normalizedId.toLowerCase()}`
        );

    if (error) {
      console.error("Reset password lookup error:", error);
      return res.status(500).json({ message: "Server error" });
    }

    const user = rows?.[0];

    if (!user) {
      return res.status(400).json({ message: "Invalid reset token or identifier" });
    }

    // Check if reset token exists and is valid
    const resetTokenHash = user.metadata?.password_reset_token;
    const resetExpires = user.metadata?.password_reset_expires;

    if (!resetTokenHash || !resetExpires) {
      return res.status(400).json({ message: "No password reset request found. Please request a new reset code." });
    }

    // Check if token has expired
    const expiresAt = new Date(resetExpires);
    if (expiresAt < new Date()) {
      return res.status(400).json({ message: "Reset token has expired. Please request a new one." });
    }

    // Verify the token
    const isTokenValid = await bcrypt.compare(resetToken, resetTokenHash);
    if (!isTokenValid) {
      return res.status(400).json({ message: "Invalid reset token" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    const { error: updateError } = await supabase
      .from("users")
      .update({
        password_hash: hashedPassword,
        metadata: {
          ...(user.metadata || {}),
          password_reset_token: null,
          password_reset_expires: null,
        },
      })
      .eq("id", user.id);

    if (updateError) {
      console.error("Error updating password:", updateError);
      return res.status(500).json({ message: "Server error" });
    }

    res.json({ message: "Password reset successfully. You can now login with your new password." });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    // Check JWT_SECRET before processing
    if (!JWT_SECRET) {
      console.error("JWT_SECRET is not configured");
      return res.status(500).json({ 
        message: "Server configuration error. Please contact administrator." 
      });
    }

    const { identifier, email, password } = req.body;
    const loginId = identifier || email;

    if (!loginId || !password) {
      return res
        .status(400)
        .json({ message: "Identifier and password are required" });
    }

    const normalizedId = loginId.trim();

    const query = supabase.from("users").select("*").limit(1);

    const { data: rows, error } = normalizedId.includes("@")
      ? await query.eq("email", normalizedId.toLowerCase())
      : await query.or(
          `student_id.eq.${normalizedId.toUpperCase()},email.eq.${normalizedId.toLowerCase()}`
        );

    if (error) {
      console.error("Login lookup error:", error);
      return res.status(500).json({ 
        message: "Database error. Please try again.",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    const user = rows?.[0];

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check if user has a password hash
    if (!user.password_hash) {
      console.error(`User ${user.email} has no password hash`);
      return res.status(401).json({ message: "Account not properly configured. Please contact administrator." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check user status
    if (user.status && user.status.toLowerCase() !== 'active') {
      return res.status(403).json({ 
        message: `Your account is ${user.status}. Please contact administrator.` 
      });
    }

    let token;
    try {
      token = generateToken(user.id, user.role);
    } catch (tokenError) {
      console.error("Token generation error:", tokenError);
      return res.status(500).json({ 
        message: "Authentication error. Please try again.",
        error: process.env.NODE_ENV === 'development' ? tokenError.message : undefined
      });
    }

    // Record admin login (non-blocking)
    if (ADMIN_ROLES.includes(user.role)) {
      recordAdminLogin(req, user.id).catch((error) => {
        console.error("Admin activity log error (non-critical):", error.message);
        // Don't fail login if activity logging fails
      });
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        studentId: user.student_id,
        courseId: user.course_id,
        status: user.status,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    console.error("Error stack:", error.stack);
    res.status(500).json({ 
      message: "Server error. Please try again.",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;

