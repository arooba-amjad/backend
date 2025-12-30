import express from "express";
import bcrypt from "bcryptjs";
import { protect, authorizeRoles } from "../middleware/authMiddleware.js";
import { requireWriteAccess, canManageAdmin } from "../middleware/rbacMiddleware.js";
import { supabase } from "../config/supabaseClient.js";

const router = express.Router();

const ADMIN_ROLES = ["admin", "super_admin", "co_admin"];
const ADMIN_ROLE_ARGS = ["admin", "super_admin", "co_admin"];
const requireAdminRole = authorizeRoles(...ADMIN_ROLE_ARGS);
const isSuperAdmin = (user) => (user?.role || "") === "super_admin";
// Helper: Check if user has full admin privileges (admin or super_admin)
const hasFullAdminAccess = (user) => {
  const role = user?.role || "";
  return role === "admin" || role === "super_admin";
};

const guardSupabase = (res) => {
  if (!supabase) {
    res.status(500).json({ message: "Supabase client is not configured" });
    return false;
  }
  return true;
};

const countRows = async (table, filter) => {
  const builder = supabase
    .from(table)
    .select("*", { count: "exact", head: true });

  if (filter) {
    builder.eq(filter.column, filter.value);
  }

  const { count, error } = await builder;

  if (error) {
    throw error;
  }

  return count ?? 0;
};

const emitAdminSnapshot = async (req) => {
  if (!supabase) {
    return;
  }

  const io = req.app.get("io");

  if (!io) {
    return;
  }

  try {
  const [teacherCount, studentCount, courseCount] = await Promise.all([
      countRows("users", { column: "role", value: "teacher" }),
      countRows("users", { column: "role", value: "student" }),
      countRows("courses"),
  ]);

  io.emit("admin-update", { teacherCount, studentCount, courseCount });
  } catch (error) {
    console.error("emitAdminSnapshot error:", error);
  }
};

const mapCourseRef = (courseId, courseRow) => {
  if (!courseId) {
    return null;
  }

  if (courseRow) {
    return {
      _id: courseRow.id,
      name: courseRow.name,
    };
  }

  return courseId;
};

const mapTeacher = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: "teacher",
  status: row.status,
  courseId: mapCourseRef(row.course_id, row.course),
  subject: row.metadata?.subject ?? null,
});

const mapStudent = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: "student",
  status: row.status,
  studentId: row.student_id,
  courseId: mapCourseRef(row.course_id, row.course),
});

const mapCourse = (row) => ({
  _id: row.id,
  name: row.name,
  description: row.description ?? "",
  teacherId: row.teacher
    ? {
        _id: row.teacher.id,
        name: row.teacher.name,
        email: row.teacher.email,
        metadata: row.teacher.metadata ?? {},
      }
    : null,
  students: (row.enrollments ?? [])
    .map((enrollment) => enrollment.student)
    .filter(Boolean)
    .map((student) => ({
      _id: student.id,
      name: student.name,
      email: student.email,
      studentId: student.student_id,
      status: student.status,
    })),
});

const mapAdminResource = (row) => {
  const uploader = row.uploader
    ? {
        id: row.uploader.id,
        name: row.uploader.name,
        role: row.uploader.role,
      }
    : null;

  const targetTeacher =
    row.visible_teacher ??
    (uploader?.role === "teacher"
      ? { id: uploader.id, name: uploader.name }
      : null);

  const scope =
    row.visibility_scope ||
    (row.course_id ? "course" : targetTeacher ? "teacher" : "global");

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? row.metadata?.description ?? null,
    type: row.type,
    fileUrl: row.file_url,
    source: uploader?.role === "teacher" ? "teacher" : "admin",
    uploadedBy: uploader,
    teacher: targetTeacher
      ? {
          id: targetTeacher.id,
          name: targetTeacher.name,
        }
      : null,
    course: row.course
      ? { id: row.course.id, name: row.course.name }
      : row.course_id
      ? { id: row.course_id, name: null }
      : null,
    visibility: {
      scope,
      courseId: row.course_id ?? null,
      teacherId: row.visible_teacher_id ?? targetTeacher?.id ?? null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const mapTeacherResourceForAdmin = (row) => ({
  id: row.id,
  title: row.title,
  description: row.metadata?.description ?? null,
  type: row.type || "document",
  fileUrl: row.file_url,
  source: row.uploader?.role === "teacher" ? "teacher" : "admin",
  uploadedBy: row.uploader
    ? {
        id: row.uploader.id,
        name: row.uploader.name,
        role: row.uploader.role,
      }
    : null,
  teacher:
    row.uploader && row.uploader.role === "teacher"
      ? { id: row.uploader.id, name: row.uploader.name }
      : null,
  course: row.course
    ? { id: row.course.id, name: row.course.name }
    : row.course_id
    ? { id: row.course_id, name: null }
    : null,
  visibility: {
    scope: "course",
    courseId: row.course_id ?? null,
    teacherId:
      row.uploader && row.uploader.role === "teacher"
        ? row.uploader.id
        : null,
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAdminManagedNote = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description ?? "",
  type: row.type || "document",
  fileUrl: row.file_url,
  source: "admin",
  uploadedBy: row.creator
    ? {
        id: row.creator.id,
        name: row.creator.name,
        role: row.creator.role,
      }
    : null,
  teacher: row.teacher
    ? {
        id: row.teacher.id,
        name: row.teacher.name,
      }
    : null,
  course: row.course
    ? {
        id: row.course.id,
        name: row.course.name,
      }
    : row.course_id
    ? { id: row.course_id, name: null }
    : null,
  visibility: {
    scope: row.visibility_scope || "course",
    courseId: row.course_id ?? null,
    teacherId: row.teacher_id ?? null,
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapTeacherTimetableSlot = (row) => ({
  id: row.id,
  teacherId: row.teacher_id,
  courseId: row.course_id,
  course: row.course
    ? {
        id: row.course.id,
        name: row.course.name,
      }
    : row.course_id
    ? { id: row.course_id, name: null }
    : null,
  dayOfWeek: row.day_of_week,
  startTime: row.start_time,
  endTime: row.end_time,
  location: row.location ?? null,
  notes: row.notes ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapCourseTimetableSlot = (row) => ({
  id: row.id,
  courseId: row.course_id,
  dayOfWeek: row.day_of_week,
  startTime: row.start_time,
  endTime: row.end_time,
  location: row.location ?? null,
  notes: row.notes ?? null,
  teacherId: row.teacher_id ?? null,
  teacher: row.teacher
    ? {
        id: row.teacher.id,
        name: row.teacher.name,
      }
    : row.teacher_id
    ? { id: row.teacher_id, name: null }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAdminAccount = (row) => {
  const customRoles =
    row.custom_roles
      ?.map((entry) => entry.role)
      ?.filter(Boolean)
      ?.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description ?? "",
        permissions: role.permissions ?? {},
      })) ?? [];

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    metadata: row.metadata ?? {},
    lastLoginAt: row.last_login_at ?? null,
    avatarUrl: row.metadata?.avatarUrl ?? null,
    customRoles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const getNotificationPreferences = async (adminId) => {
  try {
    const { data, error } = await supabase
      .from("notification_preferences")
      .select(
        `
      id,
      admin_id,
      auto_grade_updates,
      auto_attendance_changes,
      auto_assignment_uploads,
      channels,
      updated_at
    `
      )
      .eq("admin_id", adminId)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        console.warn("notification_preferences table not found, using defaults");
        return {
          admin_id: adminId,
          auto_grade_updates: false,
          auto_attendance_changes: false,
          auto_assignment_uploads: false,
          channels: ["in_app"],
        };
      }
      throw error;
    }

    return (
      data ?? {
        admin_id: adminId,
        auto_grade_updates: false,
        auto_attendance_changes: false,
        auto_assignment_uploads: false,
        channels: ["in_app"],
      }
    );
  } catch (error) {
    console.error("getNotificationPreferences error:", error);
    return {
      admin_id: adminId,
      auto_grade_updates: false,
      auto_attendance_changes: false,
      auto_assignment_uploads: false,
      channels: ["in_app"],
    };
  }
};

const upsertNotificationPreferences = async (adminId, payload) => {
  const existing = await getNotificationPreferences(adminId);

  const preferences = {
    admin_id: adminId,
    auto_grade_updates:
      payload.autoGradeUpdates ?? existing.auto_grade_updates ?? false,
    auto_attendance_changes:
      payload.autoAttendanceChanges ?? existing.auto_attendance_changes ?? false,
    auto_assignment_uploads:
      payload.autoAssignmentUploads ?? existing.auto_assignment_uploads ?? false,
    channels: payload.channels ?? existing.channels ?? ["in_app"],
  };

  try {
    const { data, error } = await supabase
      .from("notification_preferences")
      .upsert(preferences, { onConflict: "admin_id" })
      .select(
        `
      admin_id,
      auto_grade_updates,
      auto_attendance_changes,
      auto_assignment_uploads,
      channels,
      updated_at
    `
      )
      .single();

    if (error) {
      if (error.code === "42P01") {
        console.warn("notification_preferences table not found, returning defaults");
        return existing;
      }
      throw error;
    }

    return data;
  } catch (error) {
    console.error("upsertNotificationPreferences error:", error);
    return existing;
  }
};

const normalizeChannels = (channels) => {
  if (!Array.isArray(channels) || channels.length === 0) {
    return ["in_app"];
  }

  const allowed = new Set(["in_app", "email"]);
  const filtered = channels
    .map((channel) => String(channel).toLowerCase())
    .filter((channel) => allowed.has(channel));

  return filtered.length ? filtered : ["in_app"];
};

const parseCsv = (csv) => {
  if (!csv?.trim()) {
    return [];
  }

  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers = lines[0].split(",").map((header) => header.trim());

  return lines.slice(1).map((line) => {
    const values = line.split(",").map((value) => value.trim());
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index] ?? "";
      return acc;
    }, {});
  });
};

const stringifyCsv = (headers, rows) => {
  const headerLine = headers.join(",");
  const valueLines = rows.map((row) =>
    headers
      .map((header) => {
        const value =
          row[header] === null || row[header] === undefined
            ? ""
            : String(row[header]);

        if (value.includes(",") || value.includes('"')) {
          return `"${value.replace(/"/g, '""')}"`;
        }

        return value;
      })
      .join(",")
  );

  return [headerLine, ...valueLines].join("\n");
};

const generateRandomPassword = () => {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789!@#$%^&*";
  const length = 12;
  let password = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    password += chars[randomIndex];
  }
  return password;
};

const syncUserCustomRoles = async (userId, roleIds = []) => {
  const uniqueRoleIds = Array.from(
    new Set(
      roleIds
        .filter(Boolean)
        .map((roleId) => String(roleId).trim())
        .filter(Boolean)
    )
  );

  await supabase.from("user_custom_roles").delete().eq("user_id", userId);

  if (!uniqueRoleIds.length) {
    return [];
  }

  const rows = uniqueRoleIds.map((roleId) => ({
    user_id: userId,
    custom_role_id: roleId,
  }));

  const { data, error } = await supabase
    .from("user_custom_roles")
    .insert(rows)
    .select(
      `
      custom_role_id,
      role:custom_roles (
        id,
        name,
        description,
        permissions
      )
    `
    );

  if (error) {
    throw error;
  }

  return data ?? [];
};

const fetchRecipientsForAudience = async (audience) => {
  if (!audience || !audience.scope) {
    return [];
  }

  const scope = audience.scope;

  if (scope === "custom") {
    const ids = Array.from(
      new Set(
        (audience.userIds ?? [])
          .filter(Boolean)
          .map((id) => String(id).trim())
          .filter(Boolean)
      )
    );

    if (!ids.length) {
      return [];
    }

    const { data, error } = await supabase
      .from("users")
      .select("id, status")
      .in("id", ids);

    if (error) {
      throw error;
    }

    return (data ?? [])
      .filter((row) => row.status !== "suspended")
      .map((row) => row.id);
  }

  if (scope === "all_teachers") {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("role", "teacher")
      .neq("status", "suspended");

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => row.id);
  }

  if (scope === "all_students") {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("role", "student")
      .neq("status", "suspended");

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => row.id);
  }

  if (scope === "course" && audience.courseId) {
    const { data, error } = await supabase
      .from("course_students")
      .select("student_id")
      .eq("course_id", audience.courseId);

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => row.student_id);
  }

  if (scope === "section" && audience.section) {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("role", "student")
      .neq("status", "suspended")
      .contains("metadata", { section: audience.section });

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => row.id);
  }

  return [];
};

const emitNotificationEvents = (req, recipientIds, payload) => {
  const io = req.app.get("io");
  if (!io) {
    return;
  }

  recipientIds.forEach((recipientId) => {
    io.emit(`notification-update-${recipientId}`, payload);
  });
};

const fetchLastLoginAt = async (adminId) => {
  try {
    const { data, error } = await supabase
      .from("admin_activity_logs")
      .select("created_at")
      .eq("admin_id", adminId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "42P01") {
        console.warn("admin_activity_logs table not found, skipping last login fetch");
        return null;
      }
      throw error;
    }

    return data?.created_at ?? null;
  } catch (error) {
    console.error("fetchLastLoginAt error:", error);
    return null;
  }
};

router.post(
  "/createTeacher",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { name, email, password, courseId, subject, status } = req.body;

      if (!name || !email || !password) {
        return res
          .status(400)
          .json({ message: "Name, email, and password are required" });
      }

      const normalizedEmail = email.toLowerCase();

      const { data: existingEmail, error: existingEmailError } = await supabase
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (existingEmailError) {
        throw existingEmailError;
      }

      if (existingEmail) {
        return res.status(400).json({ message: "Email already in use" });
      }

      let courseRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, teacher_id")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const { data: teacherRow, error: insertError } = await supabase
        .from("users")
        .insert({
        name,
          email: normalizedEmail,
          password_hash: hashedPassword,
        role: "teacher",
        status: status || "Active",
          course_id: courseId || null,
        metadata: subject ? { subject } : {},
        })
        .select(
          `
          id,
          name,
          email,
          status,
          metadata,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .single();

      if (insertError) {
        throw insertError;
      }

      if (courseId) {
        if (courseRow?.teacher_id && courseRow.teacher_id !== teacherRow.id) {
          await supabase
            .from("users")
            .update({ course_id: null })
            .eq("id", courseRow.teacher_id);
        }

        const { error: courseUpdateError } = await supabase
          .from("courses")
          .update({ teacher_id: teacherRow.id })
          .eq("id", courseId);

        if (courseUpdateError) {
          throw courseUpdateError;
        }
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");

      if (io && courseId) {
        io.emit(`course-teacher-update-${courseId}`, {
          courseId,
          teacher: {
            id: teacherRow.id,
            name: teacherRow.name,
            email: teacherRow.email,
            subject: teacherRow.metadata?.subject ?? null,
          },
        });
        io.emit("course-updated", { courseId });
      }

      res.status(201).json({
        message: "Teacher created successfully",
        teacher: mapTeacher(teacherRow),
      });
    } catch (error) {
      console.error("Create teacher error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/createStudent",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { name, email, password, courseId, studentId, status, enrollmentId } = req.body;

      if (!name || !email || !password || !studentId) {
        return res.status(400).json({
            message: "Name, email, password, and student ID are required",
          });
      }

      const normalizedEmail = email.toLowerCase();
      const normalizedStudentId = studentId.toUpperCase();
      const normalizedCourseId =
        courseId === null || courseId === "" ? null : courseId;

      const [{ data: existingEmail, error: existingEmailError }, { data: existingStudent, error: existingStudentError }] =
        await Promise.all([
          supabase
            .from("users")
            .select("id")
            .eq("email", normalizedEmail)
            .maybeSingle(),
          supabase
            .from("users")
            .select("id")
            .eq("student_id", normalizedStudentId)
            .maybeSingle(),
        ]);

      if (existingEmailError) {
        throw existingEmailError;
      }

      if (existingStudentError) {
        throw existingStudentError;
      }

      if (existingEmail) {
        return res.status(400).json({ message: "Email already in use" });
      }

      if (existingStudent) {
        return res.status(400).json({ message: "Student ID already in use" });
      }

      if (normalizedCourseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id")
          .eq("id", normalizedCourseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const { data: studentRow, error: insertError } = await supabase
        .from("users")
        .insert({
        name,
          email: normalizedEmail,
          password_hash: hashedPassword,
        role: "student",
          student_id: normalizedStudentId,
        status: status || "Active",
          course_id:
            normalizedCourseId && status !== "Enrolled"
              ? normalizedCourseId
              : null,
          metadata: {},
        })
        .select(
          `
          id,
          name,
          email,
          status,
          student_id,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .single();

      if (insertError) {
        throw insertError;
      }

      // Check if this is linked to a pending enrollment
      if (enrollmentId) {
        // Update the existing enrollment record to link it to the new student
        const { data: enrollmentData } = await supabase
          .from("course_students")
          .select("course_id, course_name")
          .eq("id", enrollmentId)
          .is("student_id", null)
          .maybeSingle();

        if (enrollmentData) {
          // Update the enrollment to link it to the student
          const { error: updateEnrollmentError } = await supabase
            .from("course_students")
            .update({
              student_id: studentRow.id,
              student_name: name,
              student_email: normalizedEmail,
            })
            .eq("id", enrollmentId);

          if (updateEnrollmentError) {
            console.error("Error updating enrollment:", updateEnrollmentError);
            // Don't throw - continue with course enrollment if needed
          } else {
            // Update user's course_id if enrollment had a course
            if (enrollmentData.course_id) {
              await supabase
                .from("users")
                .update({ course_id: enrollmentData.course_id })
                .eq("id", studentRow.id);
            }
          }
        }
      }

      const shouldAttachCourse =
        Boolean(normalizedCourseId) && status !== "Enrolled";

      if (shouldAttachCourse) {
        // Get course name for enrollment record
        const { data: courseData } = await supabase
          .from("courses")
          .select("name")
          .eq("id", normalizedCourseId)
          .maybeSingle();

        // Check if enrollment already exists
        const { data: existingEnrollment } = await supabase
          .from("course_students")
          .select("id")
          .eq("course_id", normalizedCourseId)
          .eq("student_id", studentRow.id)
          .maybeSingle();

        if (existingEnrollment) {
          // Update existing enrollment
          const { error: enrollmentError } = await supabase
            .from("course_students")
            .update({
              student_name: name,
              student_email: normalizedEmail,
              student_phone: studentRow.metadata?.phone || null,
              course_name: courseData?.name || null,
            })
            .eq("id", existingEnrollment.id);

          if (enrollmentError) {
            console.error("Error updating enrollment:", enrollmentError);
            throw enrollmentError;
          }
        } else {
          // Create new enrollment
          const { error: enrollmentError } = await supabase
            .from("course_students")
            .insert({
              course_id: normalizedCourseId,
              student_id: studentRow.id,
              student_name: name,
              student_email: normalizedEmail,
              student_phone: studentRow.metadata?.phone || null,
              course_name: courseData?.name || null,
            });

          if (enrollmentError) {
            console.error("Error creating enrollment:", enrollmentError);
            throw enrollmentError;
          }
        }

        const { error: updateUserCourseError } = await supabase
          .from("users")
          .update({ course_id: normalizedCourseId })
          .eq("id", studentRow.id);

        if (updateUserCourseError) {
          throw updateUserCourseError;
        }
      }

      await emitAdminSnapshot(req);

      const { data: finalStudent, error: finalFetchError } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          status,
          student_id,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .eq("id", studentRow.id)
        .single();

      if (finalFetchError) {
        throw finalFetchError;
      }

      const io = req.app.get("io");

      if (io && finalStudent.course_id) {
        io.emit(`course-students-update-${finalStudent.course_id}`, {
          courseId: finalStudent.course_id,
          student: {
            id: finalStudent.id,
            name: finalStudent.name,
            email: finalStudent.email,
            studentId: finalStudent.student_id,
          },
        });
        io.emit("course-updated", { courseId: finalStudent.course_id });
      }

      res.status(201).json({
        message: "Student created successfully",
        student: mapStudent(finalStudent),
      });
    } catch (error) {
      console.error("Create student error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/students/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;
      const { name, email, password, courseId, studentId, status } = req.body;

      const { data: studentRow, error: fetchError } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          status,
          student_id,
          course_id,
          metadata
        `
        )
        .eq("id", id)
        .eq("role", "student")
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!studentRow) {
        return res.status(404).json({ message: "Student not found" });
      }

      const updates = {};

      if (name) {
        updates.name = name;
      }

      if (typeof status === "string") {
        updates.status = status;
      }

      if (email && email !== studentRow.email) {
        const { data: existingEmail, error: existingEmailError } = await supabase
          .from("users")
          .select("id")
          .eq("email", email.toLowerCase())
          .maybeSingle();

        if (existingEmailError) {
          throw existingEmailError;
        }

        if (existingEmail && existingEmail.id !== studentRow.id) {
          return res.status(400).json({ message: "Email already in use" });
        }

        updates.email = email.toLowerCase();
      }

      if (studentId && studentId.toUpperCase() !== studentRow.student_id) {
        const normalizedStudentId = studentId.toUpperCase();

        const { data: existingStudent, error: existingStudentError } =
          await supabase
            .from("users")
            .select("id")
            .eq("student_id", normalizedStudentId)
            .maybeSingle();

        if (existingStudentError) {
          throw existingStudentError;
        }

        if (existingStudent && existingStudent.id !== studentRow.id) {
          return res.status(400).json({ message: "Student ID already in use" });
        }

        updates.student_id = normalizedStudentId;
      }

      if (password) {
        updates.password_hash = await bcrypt.hash(password, 10);
      }

      const courseFieldProvided = Object.prototype.hasOwnProperty.call(
        req.body,
        "courseId"
      );
      const normalizedCourseId =
        courseId === null || courseId === "" ? null : courseId;

      if (courseFieldProvided) {
        if (normalizedCourseId) {
          const { data: courseExists, error: courseError } = await supabase
            .from("courses")
            .select("id")
            .eq("id", normalizedCourseId)
            .maybeSingle();

          if (courseError) {
            throw courseError;
          }

          if (!courseExists) {
            return res.status(404).json({ message: "Course not found" });
          }
        }

        if (
          studentRow.course_id &&
          studentRow.course_id !== normalizedCourseId
        ) {
          const { error: removeEnrollmentError } = await supabase
            .from("course_students")
            .delete()
            .eq("course_id", studentRow.course_id)
            .eq("student_id", studentRow.id);

          if (removeEnrollmentError) {
            throw removeEnrollmentError;
          }
        }

        if (
          normalizedCourseId &&
          normalizedCourseId !== studentRow.course_id
        ) {
          // Get course name for enrollment record
          const { data: courseData } = await supabase
            .from("courses")
            .select("name")
            .eq("id", normalizedCourseId)
            .maybeSingle();

          // Check if enrollment already exists
          const { data: existingEnrollment } = await supabase
            .from("course_students")
            .select("id")
            .eq("course_id", normalizedCourseId)
            .eq("student_id", studentRow.id)
            .maybeSingle();

          if (existingEnrollment) {
            // Update existing enrollment
            const { error: enrollmentError } = await supabase
              .from("course_students")
              .update({
                student_name: studentRow.name,
                student_email: studentRow.email,
                student_phone: studentRow.metadata?.phone || null,
                course_name: courseData?.name || null,
              })
              .eq("id", existingEnrollment.id);

            if (enrollmentError) {
              console.error("Error updating enrollment:", enrollmentError);
              throw enrollmentError;
            }
          } else {
            // Create new enrollment
            const { error: enrollmentError } = await supabase
              .from("course_students")
              .insert({
                course_id: normalizedCourseId,
                student_id: studentRow.id,
                student_name: studentRow.name,
                student_email: studentRow.email,
                student_phone: studentRow.metadata?.phone || null,
                course_name: courseData?.name || null,
              });

            if (enrollmentError) {
              console.error("Error creating enrollment:", enrollmentError);
              throw enrollmentError;
            }
          }
        }

        updates.course_id =
          normalizedCourseId && status !== "Enrolled"
            ? normalizedCourseId
            : null;
      }

      const { data: updatedStudent, error: updateError } = await supabase
        .from("users")
        .update(updates)
        .eq("id", studentRow.id)
        .select(
          `
          id,
          name,
          email,
          status,
          student_id,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");

      if (
        io &&
        courseFieldProvided &&
        studentRow.course_id &&
        studentRow.course_id !== updatedStudent.course_id
      ) {
        io.emit(`course-students-update-${studentRow.course_id}`, {
          courseId: studentRow.course_id,
          studentId: studentRow.id,
          action: "removed",
        });
        io.emit("course-updated", { courseId: studentRow.course_id });
      }

      if (
        io &&
        courseFieldProvided &&
        updatedStudent.course_id &&
        updatedStudent.course_id !== studentRow.course_id
      ) {
        io.emit(`course-students-update-${updatedStudent.course_id}`, {
          courseId: updatedStudent.course_id,
        student: {
            id: updatedStudent.id,
            name: updatedStudent.name,
            email: updatedStudent.email,
            studentId: updatedStudent.student_id,
          },
        });
        io.emit("course-updated", { courseId: updatedStudent.course_id });
      }

      res.json({
        message: "Student updated successfully",
        student: mapStudent(updatedStudent),
      });
    } catch (error) {
      console.error("Update student error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/teachers/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;
      const { name, email, password, status, metadata } = req.body;

      const { data: teacherRow, error: fetchError } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          status,
          metadata,
          course_id
        `
        )
        .eq("id", id)
        .eq("role", "teacher")
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!teacherRow) {
        return res.status(404).json({ message: "Teacher not found" });
      }

      const updates = {};

      if (name) {
        updates.name = name;
      }

      if (typeof status === "string") {
        updates.status = status;
      }

      if (email && email !== teacherRow.email) {
        const normalizedEmail = email.toLowerCase();
        const { data: existingEmail, error: existingEmailError } = await supabase
          .from("users")
          .select("id")
          .eq("email", normalizedEmail)
          .maybeSingle();

        if (existingEmailError) {
          throw existingEmailError;
        }

        if (existingEmail && existingEmail.id !== teacherRow.id) {
          return res.status(400).json({ message: "Email already in use" });
        }

        updates.email = normalizedEmail;
      }

      if (password) {
        updates.password_hash = await bcrypt.hash(password, 10);
      }

      if (metadata && typeof metadata === "object") {
        updates.metadata = {
          ...(teacherRow.metadata ?? {}),
          ...metadata,
        };
      }

      if (!Object.keys(updates).length) {
        return res
          .status(400)
          .json({ message: "No valid updates provided for teacher." });
      }

      const { data: updatedRow, error: updateError } = await supabase
        .from("users")
        .update(updates)
        .eq("id", id)
        .select(
          `
          id,
          name,
          email,
          status,
          metadata,
          course_id,
          course:course_id (
            id,
            name,
            description
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      const mapped = mapTeacher(updatedRow);

      res.json({
        message: "Teacher updated successfully",
        teacher: mapped,
      });
    } catch (error) {
      console.error("Update teacher error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/teachers/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;

      const { data: teacherRow, error: fetchError } = await supabase
        .from("users")
        .select("id, course_id")
        .eq("id", id)
        .eq("role", "teacher")
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!teacherRow) {
        return res.status(404).json({ message: "Teacher not found" });
      }

      // Remove teacher from course if assigned
      if (teacherRow.course_id) {
        await supabase
          .from("courses")
          .update({ teacher_id: null })
          .eq("id", teacherRow.course_id);
      }

      // Delete the teacher
      const { error: deleteError } = await supabase
        .from("users")
        .delete()
        .eq("id", id)
        .eq("role", "teacher");

      if (deleteError) {
        throw deleteError;
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");
      if (io && teacherRow.course_id) {
        io.emit("course-updated", { courseId: teacherRow.course_id });
      }

      res.json({ message: "Teacher deleted successfully" });
    } catch (error) {
      console.error("Delete teacher error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/students/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;

      const { data: studentRow, error: fetchError } = await supabase
        .from("users")
        .select("id, course_id")
        .eq("id", id)
        .eq("role", "student")
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!studentRow) {
        return res.status(404).json({ message: "Student not found" });
      }

      // Delete enrollment from course_students if exists
      if (studentRow.course_id) {
        await supabase
          .from("course_students")
          .delete()
          .eq("student_id", id)
          .eq("course_id", studentRow.course_id);
      }

      // Delete the student
      const { error: deleteError } = await supabase
        .from("users")
        .delete()
        .eq("id", id)
        .eq("role", "student");

      if (deleteError) {
        throw deleteError;
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");
      if (io && studentRow.course_id) {
        io.emit("course-updated", { courseId: studentRow.course_id });
      }

      res.json({ message: "Student deleted successfully" });
    } catch (error) {
      console.error("Delete student error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/createCourse",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { name, description, teacherId, studentIds = [] } = req.body;

      if (!name) {
        return res.status(400).json({ message: "Course name is required" });
      }

      let teacherRow = null;

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, course_id")
          .eq("id", teacherId)
          .eq("role", "teacher")
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      const { data: courseRow, error: insertError } = await supabase
        .from("courses")
        .insert({
          name,
          description: description || "",
          teacher_id: teacherId || null,
        })
        .select(
          `
          id,
        name,
        description,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          ),
          enrollments:course_students (
            student:users!course_students_student_id_fkey (
              id,
              name,
              email,
              student_id,
              status
            )
          )
        `
        )
        .single();

      if (insertError) {
        throw insertError;
      }

      if (teacherId) {
        if (teacherRow?.course_id) {
          await supabase
            .from("courses")
            .update({ teacher_id: null })
            .eq("id", teacherRow.course_id);
        }

        await supabase
          .from("users")
          .update({ course_id: courseRow.id })
          .eq("id", teacherId);
      }

      if (studentIds.length) {
        const { data: students, error: studentsError } = await supabase
          .from("users")
          .select("id")
          .eq("role", "student")
          .in("id", studentIds);

        if (studentsError) {
          throw studentsError;
        }

        if (!students || students.length !== studentIds.length) {
          return res
            .status(400)
            .json({ message: "One or more students not found" });
        }

        await supabase
          .from("users")
          .update({ course_id: courseRow.id })
          .in("id", studentIds);

        // Get student details for enrollment records
        const { data: studentsData } = await supabase
          .from("users")
          .select("id, name, email, metadata")
          .in("id", studentIds);

        const studentsMap = new Map((studentsData || []).map(s => [s.id, s]));

        await supabase.from("course_students").upsert(
          studentIds.map((studentIdValue) => {
            const student = studentsMap.get(studentIdValue);
            return {
              course_id: courseRow.id,
              student_id: studentIdValue,
              student_name: student?.name || null,
              student_email: student?.email || null,
              student_phone: student?.metadata?.phone || null,
              course_name: courseRow.name || null,
            };
          })
        );
      }

      await emitAdminSnapshot(req);

      const { data: finalCourse, error: finalCourseError } = await supabase
        .from("courses")
        .select(
          `
          id,
          name,
          description,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          ),
          enrollments:course_students (
            student:users!course_students_student_id_fkey (
              id,
              name,
              email,
              student_id,
              status
            )
          )
        `
        )
        .eq("id", courseRow.id)
        .maybeSingle();

      if (finalCourseError) {
        throw finalCourseError;
      }

      const io = req.app.get("io");

      if (io) {
        io.emit("course-created", { id: courseRow.id });
        io.emit("course-updated", { courseId: courseRow.id });
      }

      res.status(201).json({
        message: "Course created successfully",
        course: mapCourse(finalCourse ?? courseRow),
      });
    } catch (error) {
      console.error("Create course error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/assignCourse/:courseId/:teacherId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { courseId, teacherId } = req.params;

      const [{ data: courseRow, error: courseError }, { data: teacherRow, error: teacherError }] =
        await Promise.all([
          supabase
            .from("courses")
            .select("id, teacher_id")
            .eq("id", courseId)
            .maybeSingle(),
          supabase
            .from("users")
            .select("id, course_id")
            .eq("id", teacherId)
            .eq("role", "teacher")
            .maybeSingle(),
        ]);

      if (courseError) {
        throw courseError;
      }

      if (teacherError) {
        throw teacherError;
      }

      if (!courseRow) {
        return res.status(404).json({ message: "Course not found" });
      }

      if (!teacherRow) {
        return res.status(404).json({ message: "Teacher not found" });
      }

      if (courseRow.teacher_id && courseRow.teacher_id !== teacherRow.id) {
        await supabase
          .from("users")
          .update({ course_id: null })
          .eq("id", courseRow.teacher_id);
      }

      await supabase
        .from("courses")
        .update({ teacher_id: teacherRow.id })
        .eq("id", courseId);

      await supabase
        .from("users")
        .update({ course_id: courseId })
        .eq("id", teacherRow.id);

      await emitAdminSnapshot(req);

      const io = req.app.get("io");

      if (io) {
        io.emit(`course-teacher-update-${courseId}`, {
          courseId,
          teacherId: teacherRow.id,
      });
        io.emit("course-updated", { courseId });
      }

      res.json({ message: "Teacher assigned to course successfully" });
    } catch (error) {
      console.error("Assign course error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/resources",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      // First, try to get resources with relationships
      let { data, error } = await supabase
        .from("resources")
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          course_id,
          uploaded_by,
          visibility_scope,
          visible_teacher_id,
          metadata,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          ),
          uploader:uploaded_by (
            id,
            name,
            role
          ),
          visible_teacher:visible_teacher_id (
            id,
            name
          )
        `
        )
        .order("created_at", { ascending: false });

      // If the query fails due to foreign key issues, try a simpler query
      if (error && (error.code === "42703" || error.message?.includes("column") || error.message?.includes("relation"))) {
        console.warn("Complex resources query failed, trying simple query:", error.message);
        const simpleQuery = await supabase
          .from("resources")
          .select("id, title, description, type, file_url, course_id, uploaded_by, visibility_scope, visible_teacher_id, metadata, created_at, updated_at")
          .order("created_at", { ascending: false });
        
        if (simpleQuery.error) {
          throw simpleQuery.error;
        }
        
        // Manually fetch related data
        data = await Promise.all((simpleQuery.data ?? []).map(async (row) => {
          const result = { ...row, course: null, uploader: null, visible_teacher: null };
          
          if (row.course_id) {
            const { data: courseData } = await supabase
              .from("courses")
              .select("id, name")
              .eq("id", row.course_id)
              .maybeSingle();
            result.course = courseData;
          }
          
          if (row.uploaded_by) {
            const { data: userData } = await supabase
              .from("users")
              .select("id, name, role")
              .eq("id", row.uploaded_by)
              .maybeSingle();
            result.uploader = userData;
          }
          
          if (row.visible_teacher_id) {
            const { data: teacherData } = await supabase
              .from("users")
              .select("id, name")
              .eq("id", row.visible_teacher_id)
              .maybeSingle();
            result.visible_teacher = teacherData;
          }
          
          return result;
        }));
        
        error = null;
      }

      if (error) {
        if (error.code === "42P01" || error.code === "42703" || error.message?.includes("does not exist") || error.message?.includes("column") || error.message?.includes("relation")) {
          console.warn("Resources query error (table/column may not exist), returning empty array:", error.message);
          return res.json([]);
        }
        console.error("Fetch admin resources error:", error);
        console.error("Error details:", JSON.stringify(error, null, 2));
        // Don't throw - return empty array instead
        return res.json([]);
      }

      if (!data || !Array.isArray(data)) {
        console.warn("Resources query returned invalid data, returning empty array");
        return res.json([]);
      }

      try {
        const mapped = (data ?? []).map((row) => {
          try {
            return mapAdminResource(row);
          } catch (mapError) {
            console.error("Error mapping resource row:", mapError, "Row:", row);
            return null;
          }
        }).filter(Boolean);
        
        res.json(mapped);
      } catch (mapError) {
        console.error("Error mapping resources:", mapError);
        res.json([]);
      }
    } catch (error) {
      console.error("Fetch admin resources error:", error);
      console.error("Error stack:", error.stack);
      // Return empty array instead of 500 error to prevent frontend crashes
      res.json([]);
    }
  }
);

router.post(
  "/resources",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const {
        title,
        description,
        fileUrl,
        type,
        courseId,
        teacherId,
        visibilityScope,
      } = req.body;

      if (!title || !fileUrl) {
        return res
          .status(400)
          .json({ message: "Title and file URL are required" });
      }

      const allowedScopes = new Set(["course", "teacher", "global"]);
      let resolvedScope =
        typeof visibilityScope === "string" && allowedScopes.has(visibilityScope)
          ? visibilityScope
          : null;

      let courseRow = null;
      let teacherRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data || data.role !== "teacher") {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      if (!resolvedScope) {
        if (courseRow) {
          resolvedScope = "course";
        } else if (teacherRow) {
          resolvedScope = "teacher";
        } else {
          resolvedScope = "global";
        }
      }

      if (resolvedScope === "course" && !courseRow) {
        return res
          .status(400)
          .json({ message: "Course is required for course visibility" });
      }

      if (resolvedScope === "teacher" && !teacherRow) {
        return res
          .status(400)
          .json({ message: "Teacher is required for teacher visibility" });
      }

      const payload = {
        title,
        description: description ?? "",
        type: type || "link",
        file_url: fileUrl,
        course_id: courseRow ? courseRow.id : null,
        uploaded_by: req.user.id,
        visibility_scope: resolvedScope,
        visible_teacher_id: teacherRow ? teacherRow.id : null,
      };

      // First insert the resource
      const { data: insertedResource, error: insertError } = await supabase
        .from("resources")
        .insert(payload)
        .select("id, title, description, type, file_url, course_id, uploaded_by, visibility_scope, visible_teacher_id, metadata, created_at, updated_at")
        .single();

      if (insertError) {
        if (insertError.code === "42P01") {
          return res.status(500).json({
            message:
              "Resources table not found. Please run the provided SQL migration to create resources.",
          });
        }
        console.error("Resource insert error:", insertError);
        return res.status(500).json({ 
          message: "Failed to create resource",
          error: insertError.message 
        });
      }

      // Then fetch with relationships separately to avoid foreign key join issues
      let resourceRow = { ...insertedResource };
      
      // Fetch course if course_id exists
      if (insertedResource.course_id) {
        const { data: courseData } = await supabase
          .from("courses")
          .select("id, name")
          .eq("id", insertedResource.course_id)
          .maybeSingle();
        resourceRow.course = courseData;
      }

      // Fetch uploader
      if (insertedResource.uploaded_by) {
        const { data: uploaderData } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", insertedResource.uploaded_by)
          .maybeSingle();
        resourceRow.uploader = uploaderData;
      }

      // Fetch visible teacher if visible_teacher_id exists
      if (insertedResource.visible_teacher_id) {
        const { data: teacherData } = await supabase
          .from("users")
          .select("id, name")
          .eq("id", insertedResource.visible_teacher_id)
          .maybeSingle();
        resourceRow.visible_teacher = teacherData;
      }

      const io = req.app.get("io");
      io?.emit("admin-resources-refresh", {
        resourceId: resourceRow.id,
        action: "create",
      });

      res.status(201).json({
        message: "Resource uploaded successfully",
        resource: mapAdminResource(resourceRow),
      });
    } catch (error) {
      console.error("Create admin resource error:", error);
      res.status(500).json({ 
        message: "Server error",
        error: error.message || "An unexpected error occurred"
      });
    }
  }
);

router.put(
  "/resources/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;
      const {
        title,
        description,
        fileUrl,
        type,
        courseId,
          teacherId,
        visibilityScope,
      } = req.body;

      const { data: existing, error: existingError } = await supabase
        .from("resources")
        .select(
          `
          id,
          course_id,
          visibility_scope,
          visible_teacher_id
        `
        )
        .eq("id", id)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Resource not found" });
      }

      const allowedScopes = new Set(["course", "teacher", "global"]);
      let resolvedScope =
        typeof visibilityScope === "string" && allowedScopes.has(visibilityScope)
          ? visibilityScope
          : existing.visibility_scope || "course";

      let courseRow = null;
      let teacherRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
      }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data || data.role !== "teacher") {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      if (resolvedScope === "course" && !(courseRow || existing.course_id)) {
        return res
          .status(400)
          .json({ message: "Course is required for course visibility" });
      }

      if (
        resolvedScope === "teacher" &&
        !(teacherRow || existing.visible_teacher_id)
      ) {
        return res
          .status(400)
          .json({ message: "Teacher is required for teacher visibility" });
      }

      const updatePayload = {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(fileUrl !== undefined ? { file_url: fileUrl } : {}),
        visibility_scope: resolvedScope,
        course_id:
          resolvedScope === "course"
            ? courseRow
              ? courseRow.id
              : existing.course_id
            : null,
        visible_teacher_id:
          resolvedScope === "teacher"
            ? teacherRow
              ? teacherRow.id
              : existing.visible_teacher_id
            : null,
      };

      const { data: resourceRow, error: updateError } = await supabase
        .from("resources")
        .update(updatePayload)
        .eq("id", id)
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          course_id,
          uploaded_by,
          visibility_scope,
          visible_teacher_id,
          metadata,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          ),
          uploader:uploaded_by (
            id,
            name,
            role
          ),
          visible_teacher:visible_teacher_id (
            id,
            name
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      const io = req.app.get("io");
      io?.emit("admin-resources-refresh", {
        resourceId: resourceRow.id,
        action: "update",
      });

      res.json({
        message: "Resource updated successfully",
        resource: mapAdminResource(resourceRow),
      });
    } catch (error) {
      console.error("Update admin resource error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/resources/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;

      const { data: existing, error: existingError } = await supabase
        .from("resources")
        .select("id")
        .eq("id", id)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Resource not found" });
      }

      const { error: deleteError } = await supabase
        .from("resources")
        .delete()
        .eq("id", id);

      if (deleteError) {
        throw deleteError;
      }

      const io = req.app.get("io");
      io?.emit("admin-resources-refresh", { resourceId: id, action: "delete" });

      res.json({ message: "Resource deleted successfully" });
    } catch (error) {
      console.error("Delete admin resource error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/timetable/teachers/:teacherId/slots",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { teacherId } = req.params;

    try {
      const { data: teacherRow, error: teacherError } = await supabase
        .from("users")
        .select("id")
        .eq("id", teacherId)
        .eq("role", "teacher")
        .maybeSingle();

      if (teacherError) {
        throw teacherError;
      }

      if (!teacherRow) {
        return res.status(404).json({ message: "Teacher not found" });
      }

      const { data, error } = await supabase
        .from("teacher_schedule_slots")
        .select(
          `
          id,
          teacher_id,
          course_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          )
        `
        )
        .eq("teacher_id", teacherId)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true });

      if (error) {
        if (error.code === "42P01") {
          return res.status(500).json({
            message:
              "Teacher schedule table not found. Please run the provided SQL migration to create teacher_schedule_slots.",
          });
        }
        throw error;
      }

      res.json((data ?? []).map(mapTeacherTimetableSlot));
    } catch (error) {
      console.error("Fetch teacher timetable error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/timetable/teachers/:teacherId/slots",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { teacherId } = req.params;
    const { dayOfWeek, startTime, endTime, courseId, location, notes } = req.body;

    try {
      if (!dayOfWeek || !startTime || !endTime) {
        return res
          .status(400)
          .json({ message: "Day, start time, and end time are required" });
      }

      const { data: teacherRow, error: teacherError } = await supabase
        .from("users")
        .select("id")
        .eq("id", teacherId)
        .eq("role", "teacher")
        .maybeSingle();

      if (teacherError) {
        throw teacherError;
      }

      if (!teacherRow) {
        return res.status(404).json({ message: "Teacher not found" });
      }

      let courseRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      const { data: slotRow, error: insertError } = await supabase
        .from("teacher_schedule_slots")
        .insert({
          teacher_id: teacherRow.id,
          course_id: courseRow ? courseRow.id : null,
          day_of_week: dayOfWeek,
          start_time: startTime,
          end_time: endTime,
          location: location ?? null,
          notes: notes ?? null,
        })
        .select(
          `
          id,
          teacher_id,
          course_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          )
        `
        )
        .single();

      if (insertError) {
        if (insertError.code === "42P01") {
          return res.status(500).json({
            message:
              "Teacher schedule table not found. Please run the provided SQL migration to create teacher_schedule_slots.",
          });
        }

        throw insertError;
      }

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "teacher",
        teacherId: teacherRow.id,
        slotId: slotRow.id,
        action: "create",
      });

      res.status(201).json({
        message: "Slot added successfully",
        slot: mapTeacherTimetableSlot(slotRow),
      });
    } catch (error) {
      console.error("Create teacher slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Helper function to sync teacher_schedule_slots to course_schedule_slots
// This finds course slots for the same course/teacher and updates them to match the teacher slot
const syncTeacherSlotToCourseSlot = async (teacherSlot, oldValues = null) => {
  if (!teacherSlot.course_id || !teacherSlot.teacher_id) {
    console.log("[Sync Teacher Slot] Skipping sync - no course_id or teacher_id");
    return;
  }

  try {
    console.log("[Sync Teacher Slot] Starting sync for:", {
      course_id: teacherSlot.course_id,
      teacher_id: teacherSlot.teacher_id,
      new_day: teacherSlot.day_of_week,
      new_start: teacherSlot.start_time,
      new_end: teacherSlot.end_time,
      old_day: oldValues?.day_of_week,
      old_start: oldValues?.start_time,
      old_end: oldValues?.end_time,
    });

    // First, get ALL course slots for this course/teacher to see what we have
    const { data: allCourseSlots, error: findAllError } = await supabase
      .from("course_schedule_slots")
      .select("id, day_of_week, start_time, end_time")
      .eq("course_id", teacherSlot.course_id)
      .eq("teacher_id", teacherSlot.teacher_id);

    if (findAllError) {
      console.error("[Sync Teacher Slot] Error finding course slots:", findAllError);
      return;
    }

    console.log(`[Sync Teacher Slot] Found ${allCourseSlots?.length || 0} existing course slot(s) for this course/teacher`);

    let courseSlotToUpdate = null;

    // Strategy 1: If old values provided, find course slot matching OLD values (this is an UPDATE)
    if (oldValues && oldValues.day_of_week && oldValues.start_time && oldValues.end_time) {
      if (allCourseSlots && allCourseSlots.length > 0) {
        // Try exact match first
        const exactMatch = allCourseSlots.find(s => 
          s.day_of_week === oldValues.day_of_week &&
          s.start_time === oldValues.start_time &&
          s.end_time === oldValues.end_time
        );

        if (exactMatch) {
          courseSlotToUpdate = exactMatch;
          console.log(`[Sync Teacher Slot] Found exact match for OLD values: ${oldValues.day_of_week} ${oldValues.start_time}-${oldValues.end_time}`);
        } else {
          // If no exact match, check if there's a slot that matches the day (might have time differences)
          const dayMatch = allCourseSlots.find(s => s.day_of_week === oldValues.day_of_week);
          if (dayMatch && allCourseSlots.length === 1) {
            // Only one slot and it matches the day - update it
            courseSlotToUpdate = dayMatch;
            console.log(`[Sync Teacher Slot] Found day match for OLD day: ${oldValues.day_of_week}`);
          } else if (allCourseSlots.length === 1) {
            // Only one slot exists - must be the one to update
            courseSlotToUpdate = allCourseSlots[0];
            console.log("[Sync Teacher Slot] Only one course slot exists, will update it");
          }
        }
      }
    } else {
      // No old values - this might be a new slot or update without old values
      // Check if there's already a slot with the new values
      if (allCourseSlots && allCourseSlots.length > 0) {
        const matchingNew = allCourseSlots.find(s => 
          s.day_of_week === teacherSlot.day_of_week &&
          s.start_time === teacherSlot.start_time &&
          s.end_time === teacherSlot.end_time
        );

        if (matchingNew) {
          // Already exists with new values, no need to update
          console.log("[Sync Teacher Slot] Course slot with new values already exists, skipping");
          return;
        } else if (allCourseSlots.length === 1) {
          // Only one slot exists, update it
          courseSlotToUpdate = allCourseSlots[0];
          console.log("[Sync Teacher Slot] Only one course slot exists, will update it to match teacher slot");
        }
      }
    }

    // Update the course slot if we found one to update
    if (courseSlotToUpdate) {
      const courseSlotUpdate = {
        day_of_week: teacherSlot.day_of_week,
        start_time: teacherSlot.start_time,
        end_time: teacherSlot.end_time,
        location: teacherSlot.location || null,
        notes: teacherSlot.notes || null,
      };

      console.log(`[Sync Teacher Slot] Updating course slot ${courseSlotToUpdate.id} from ${courseSlotToUpdate.day_of_week} ${courseSlotToUpdate.start_time}-${courseSlotToUpdate.end_time} to ${teacherSlot.day_of_week} ${teacherSlot.start_time}-${teacherSlot.end_time}`);

      const { data: updatedSlots, error: updateError } = await supabase
        .from("course_schedule_slots")
        .update(courseSlotUpdate)
        .eq("id", courseSlotToUpdate.id)
        .select("id, day_of_week, start_time, end_time");

      if (updateError) {
        console.error("[Sync Teacher Slot] ❌ Error updating course slot:", updateError);
      } else {
        console.log(`[Sync Teacher Slot] ✅ Successfully updated course slot: ${updatedSlots[0]?.day_of_week} ${updatedSlots[0]?.start_time}-${updatedSlots[0]?.end_time}`);
      }
      return; // Exit early after update
    }

    // No slot found to update - check if we should create a new one
    // Only create if there's no slot with the new values already
    if (allCourseSlots && allCourseSlots.length > 0) {
      const existingNew = allCourseSlots.find(s => 
        s.day_of_week === teacherSlot.day_of_week &&
        s.start_time === teacherSlot.start_time &&
        s.end_time === teacherSlot.end_time
      );

      if (existingNew) {
        console.log("[Sync Teacher Slot] Course slot with new values already exists, skipping creation");
        return;
      }
    }

    // Create new course slot only if we don't have old values (new slot creation)
    // OR if we couldn't find the old slot to update
    console.log("[Sync Teacher Slot] Creating new course slot");
    const { data: newSlot, error: insertError } = await supabase
      .from("course_schedule_slots")
      .insert({
        course_id: teacherSlot.course_id,
        teacher_id: teacherSlot.teacher_id,
        day_of_week: teacherSlot.day_of_week,
        start_time: teacherSlot.start_time,
        end_time: teacherSlot.end_time,
        location: teacherSlot.location || null,
        notes: teacherSlot.notes || null,
      })
      .select("id, day_of_week, start_time, end_time")
      .single();

    if (insertError) {
      console.error("[Sync Teacher Slot] ❌ Error creating course slot:", insertError);
    } else {
      console.log(`[Sync Teacher Slot] ✅ Created new course slot: ${newSlot.day_of_week} ${newSlot.start_time}-${newSlot.end_time}`);
    }
  } catch (error) {
    console.error("[Sync Teacher Slot] ❌ Unexpected error:", error);
    console.error("[Sync Teacher Slot] Error stack:", error.stack);
  }
};

router.put(
  "/timetable/teachers/slots/:slotId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { slotId } = req.params;
    const { dayOfWeek, startTime, endTime, courseId, location, notes } = req.body;

    try {
      // Get existing slot to capture old values for syncing
      const { data: existing, error: existingError } = await supabase
        .from("teacher_schedule_slots")
        .select("*")
        .eq("id", slotId)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Slot not found" });
      }

      let courseRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
        return res.status(404).json({ message: "Course not found" });
      }

        courseRow = data;
      }

      const payload = {
        ...(dayOfWeek ? { day_of_week: dayOfWeek } : {}),
        ...(startTime ? { start_time: startTime } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        course_id: courseRow
          ? courseRow.id
          : courseId === ""
          ? null
          : existing.course_id,
        location:
          location === undefined ? existing.location : location ?? null,
        notes: notes === undefined ? existing.notes : notes ?? null,
      };

      const { data: slotRow, error: updateError } = await supabase
        .from("teacher_schedule_slots")
        .update(payload)
        .eq("id", slotId)
        .select(
          `
          id,
          teacher_id,
          course_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      // Sync to course_schedule_slots so students see the update
      // Pass old values so we can find and update the correct course slot
      const oldValues = {
        day_of_week: existing.day_of_week,
        start_time: existing.start_time,
        end_time: existing.end_time,
      };
      await syncTeacherSlotToCourseSlot(slotRow, oldValues);

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "teacher",
        teacherId: slotRow.teacher_id,
        slotId: slotRow.id,
        action: "update",
      });
      // Emit event to refresh student timetables
      if (slotRow.course_id) {
        io?.emit("student-timetable-refresh", {
          courseId: slotRow.course_id,
        });
      }

      res.json({
        message: "Slot updated successfully",
        slot: mapTeacherTimetableSlot(slotRow),
      });
    } catch (error) {
      console.error("Update teacher slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/timetable/teachers/slots/:slotId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { slotId } = req.params;

    try {
      const { data: existing, error: existingError } = await supabase
        .from("teacher_schedule_slots")
        .select("id, teacher_id")
        .eq("id", slotId)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Slot not found" });
      }

      const { error: deleteError } = await supabase
        .from("teacher_schedule_slots")
        .delete()
        .eq("id", slotId);

      if (deleteError) {
        throw deleteError;
      }

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "teacher",
        teacherId: existing.teacher_id,
        slotId: existing.id,
        action: "delete",
      });

      res.json({ message: "Slot deleted successfully" });
    } catch (error) {
      console.error("Delete teacher slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/timetable/courses/:courseId/slots",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { courseId } = req.params;

    try {
      const { data: courseRow, error: courseError } = await supabase
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) {
        throw courseError;
      }

      if (!courseRow) {
        return res.status(404).json({ message: "Course not found" });
      }

      const { data, error } = await supabase
        .from("course_schedule_slots")
        .select(
          `
          id,
          course_id,
          teacher_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          teacher:teacher_id (
            id,
            name
          )
        `
        )
        .eq("course_id", courseId)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true });

      if (error) {
        if (error.code === "42P01") {
          return res.status(500).json({
            message:
              "Course schedule table not found. Please run the provided SQL migration to create course_schedule_slots.",
          });
        }

        throw error;
      }

      res.json((data ?? []).map(mapCourseTimetableSlot));
    } catch (error) {
      console.error("Fetch course timetable error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/timetable/courses/:courseId/slots",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { courseId } = req.params;
    const { dayOfWeek, startTime, endTime, teacherId, location, notes } = req.body;

    try {
      if (!dayOfWeek || !startTime || !endTime) {
        return res
          .status(400)
          .json({ message: "Day, start time, and end time are required" });
      }

      const { data: courseRow, error: courseError } = await supabase
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) {
        throw courseError;
      }

      if (!courseRow) {
        return res.status(404).json({ message: "Course not found" });
      }

      let teacherRow = null;

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data || data.role !== "teacher") {
        return res.status(404).json({ message: "Teacher not found" });
      }

        teacherRow = data;
      }

      const { data: slotRow, error: insertError } = await supabase
        .from("course_schedule_slots")
        .insert({
          course_id: courseRow.id,
          teacher_id: teacherRow ? teacherRow.id : null,
          day_of_week: dayOfWeek,
          start_time: startTime,
          end_time: endTime,
          location: location ?? null,
          notes: notes ?? null,
        })
        .select(
          `
          id,
          course_id,
          teacher_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          teacher:teacher_id (
            id,
            name
          )
        `
        )
        .single();

      if (insertError) {
        if (insertError.code === "42P01") {
          return res.status(500).json({
            message:
              "Course schedule table not found. Please run the provided SQL migration to create course_schedule_slots.",
          });
        }

        throw insertError;
      }

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "course",
        courseId: slotRow.course_id,
        slotId: slotRow.id,
        action: "create",
      });

      res.status(201).json({
        message: "Slot added successfully",
        slot: mapCourseTimetableSlot(slotRow),
      });
    } catch (error) {
      console.error("Create course slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/timetable/courses/slots/:slotId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { slotId } = req.params;
    const { dayOfWeek, startTime, endTime, teacherId, location, notes } = req.body;

    try {
      const { data: existing, error: existingError } = await supabase
        .from("course_schedule_slots")
        .select(
          `
          id,
          course_id,
          teacher_id
        `
        )
        .eq("id", slotId)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Slot not found" });
      }

      let teacherRow = null;

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data || data.role !== "teacher") {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      const payload = {
        ...(dayOfWeek ? { day_of_week: dayOfWeek } : {}),
        ...(startTime ? { start_time: startTime } : {}),
        ...(endTime ? { end_time: endTime } : {}),
        teacher_id:
          teacherId === ""
            ? null
            : teacherRow
            ? teacherRow.id
            : existing.teacher_id,
        location:
          location === undefined ? existing.location : location ?? null,
        notes: notes === undefined ? existing.notes : notes ?? null,
      };

      const { data: slotRow, error: updateError } = await supabase
        .from("course_schedule_slots")
        .update(payload)
        .eq("id", slotId)
        .select(
          `
          id,
          course_id,
          teacher_id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          created_at,
          updated_at,
          teacher:teacher_id (
            id,
            name
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "course",
        courseId: slotRow.course_id,
        slotId: slotRow.id,
        action: "update",
      });

      res.json({
        message: "Slot updated successfully",
        slot: mapCourseTimetableSlot(slotRow),
      });
    } catch (error) {
      console.error("Update course slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/timetable/courses/slots/:slotId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { slotId } = req.params;

    try {
      const { data: existing, error: existingError } = await supabase
        .from("course_schedule_slots")
        .select("id, course_id")
        .eq("id", slotId)
        .maybeSingle();

      if (existingError) {
        throw existingError;
      }

      if (!existing) {
        return res.status(404).json({ message: "Slot not found" });
      }

      const { error: deleteError } = await supabase
        .from("course_schedule_slots")
        .delete()
        .eq("id", slotId);

      if (deleteError) {
        throw deleteError;
      }

      const io = req.app.get("io");
      io?.emit("admin-timetable-refresh", {
        scope: "course",
        courseId: existing.course_id,
        slotId: existing.id,
        action: "delete",
      });

      res.json({ message: "Slot deleted successfully" });
    } catch (error) {
      console.error("Delete course slot error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/notes/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;
      const {
        title,
        description,
        fileUrl,
        type,
        courseId,
        teacherId,
        visibilityScope,
      } = req.body;

      if (!title || !fileUrl) {
        return res
          .status(400)
          .json({ message: "Title and file URL are required" });
      }

      // Check if note exists
      const { data: existingNote, error: fetchError } = await supabase
        .from("admin_notes")
        .select("id, created_by")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!existingNote) {
        return res.status(404).json({ message: "Note not found" });
      }

      const allowedScopes = new Set(["course", "teacher", "global"]);
      let resolvedScope =
        typeof visibilityScope === "string" && allowedScopes.has(visibilityScope)
          ? visibilityScope
          : null;

      let courseRow = null;
      let teacherRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name, teacher_id")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .eq("role", "teacher")
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      if (!resolvedScope) {
        if (courseRow) {
          resolvedScope = "course";
        } else if (teacherRow) {
          resolvedScope = "teacher";
        } else {
          resolvedScope = "global";
        }
      }

      const { data: noteRow, error: updateError } = await supabase
        .from("admin_notes")
        .update({
          title,
          description: description ?? "",
          type: type || "document",
          file_url: fileUrl,
          course_id: courseId || null,
          teacher_id: teacherId || null,
          visibility_scope: resolvedScope,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          visibility_scope,
          course_id,
          teacher_id,
          created_by,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          ),
          teacher:teacher_id (
            id,
            name
          ),
          creator:created_by (
            id,
            name,
            role
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      const io = req.app.get("io");
      io?.emit("admin-notes-refresh", {
        noteId: noteRow.id,
        courseId: noteRow.course_id,
        teacherId: noteRow.teacher_id,
      });

      res.json({
        message: "Note updated successfully",
        note: mapAdminManagedNote(noteRow),
      });
    } catch (error) {
      console.error("Update admin note error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/notes/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;

      // Check if note exists
      const { data: existingNote, error: fetchError } = await supabase
        .from("admin_notes")
        .select("id, course_id, teacher_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!existingNote) {
        return res.status(404).json({ message: "Note not found" });
      }

      const { error: deleteError } = await supabase
        .from("admin_notes")
        .delete()
        .eq("id", id);

      if (deleteError) {
        throw deleteError;
      }

      const io = req.app.get("io");
      io?.emit("admin-notes-refresh", {
        noteId: id,
        courseId: existingNote.course_id,
        teacherId: existingNote.teacher_id,
        action: "delete",
      });

      res.json({
        message: "Note deleted successfully",
      });
    } catch (error) {
      console.error("Delete admin note error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/notes",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const [
        { data: teacherResources, error: teacherResourcesError },
        { data: adminNotes, error: adminNotesError },
      ] = await Promise.all([
        supabase
          .from("resources")
          .select(
            `
            id,
            title,
            type,
            file_url,
            course_id,
            uploaded_by,
            created_at,
            updated_at,
            course:course_id (
              id,
              name
            ),
            uploader:uploaded_by (
              id,
              name,
              role
            )
          `
          )
          .order("created_at", { ascending: false }),
        supabase
          .from("admin_notes")
          .select(
            `
            id,
            title,
            description,
            type,
            file_url,
            visibility_scope,
            course_id,
            teacher_id,
            created_by,
            created_at,
            updated_at,
            course:course_id (
              id,
              name
            ),
            teacher:teacher_id (
              id,
              name
            ),
            creator:created_by (
              id,
              name,
              role
            )
          `
          )
          .order("created_at", { ascending: false }),
      ]);

      if (teacherResourcesError) {
        throw teacherResourcesError;
      }

      if (adminNotesError) {
        if (adminNotesError.code === "42P01") {
          return res.status(500).json({
            message:
              "Admin notes table not found. Please run the provided SQL migration to create admin_notes.",
          });
        }

        throw adminNotesError;
      }

      const combined = [
        ...(teacherResources ?? []).map(mapTeacherResourceForAdmin),
        ...(adminNotes ?? []).map(mapAdminManagedNote),
      ].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.json(combined);
    } catch (error) {
      console.error("Fetch notes error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Generate signed upload URL for direct upload to Supabase
// This avoids sending large files through the backend
router.post(
  "/upload-file-url",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { fileName: originalFileName, fileType, courseId, uploaderId } = req.body;
      
      if (!originalFileName) {
        return res.status(400).json({ message: "File name is required" });
      }

      const fileExt = originalFileName.split('.').pop() || 'bin';
      const prefixSegments = [
        courseId || 'general',
        uploaderId || req.user.id || 'admin',
      ];

      const storageFileName = `${prefixSegments.join('/')}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}${fileExt ? `.${fileExt}` : ''}`;

      // Generate signed upload URL (valid for 1 hour)
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from('course-resources')
        .createSignedUploadUrl(storageFileName, {
          upsert: false,
        });

      if (signedUrlError) {
        console.error('Signed URL creation error:', signedUrlError);
        return res.status(500).json({ 
          message: 'Failed to create upload URL',
          error: signedUrlError.message 
        });
      }

      // Also get the public URL for after upload
      const { data: { publicUrl } } = supabase.storage
        .from('course-resources')
        .getPublicUrl(storageFileName);

      res.json({
        message: 'Upload URL generated',
        uploadUrl: signedUrlData.signedUrl,
        path: signedUrlData.path,
        publicUrl: publicUrl,
        token: signedUrlData.token,
      });
    } catch (error) {
      console.error('Generate upload URL error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// Confirm file upload completion and return public URL
router.post(
  "/upload-file-confirm",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { path } = req.body;
      
      if (!path) {
        return res.status(400).json({ message: "File path is required" });
      }

      // Get the public URL for the uploaded file
      const { data: { publicUrl } } = supabase.storage
        .from('course-resources')
        .getPublicUrl(path);

      res.json({
        message: 'File upload confirmed',
        fileUrl: publicUrl,
        fileName: path,
      });
    } catch (error) {
      console.error('Confirm upload error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

router.post(
  "/notes",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const {
        title,
        description,
        fileUrl,
        type,
        courseId,
        teacherId,
        visibilityScope,
      } = req.body;

      if (!title || !fileUrl) {
        return res
          .status(400)
          .json({ message: "Title and file URL are required" });
      }

      const allowedScopes = new Set(["course", "teacher", "global"]);
      let resolvedScope =
        typeof visibilityScope === "string" && allowedScopes.has(visibilityScope)
          ? visibilityScope
          : null;

      let courseRow = null;
      let teacherRow = null;

      if (courseId) {
        const { data, error } = await supabase
          .from("courses")
          .select("id, name, teacher_id")
          .eq("id", courseId)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Course not found" });
        }

        courseRow = data;
      }

      if (teacherId) {
        const { data, error } = await supabase
          .from("users")
          .select("id, name, role")
          .eq("id", teacherId)
          .eq("role", "teacher")
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (!data) {
          return res.status(404).json({ message: "Teacher not found" });
        }

        teacherRow = data;
      }

      if (!resolvedScope) {
        if (courseRow) {
          resolvedScope = "course";
        } else if (teacherRow) {
          resolvedScope = "teacher";
        } else {
          resolvedScope = "global";
        }
      }

      if (courseRow && teacherRow && courseRow.teacher_id) {
        if (courseRow.teacher_id !== teacherRow.id) {
          console.warn(
            `Admin note visibility mismatch: teacher ${teacherRow.id} does not own course ${courseRow.id}`
          );
        }
      }

      const { data: noteRow, error: insertError } = await supabase
        .from("admin_notes")
        .insert({
          title,
          description: description ?? "",
          type: type || "document",
          file_url: fileUrl,
          course_id: courseId || null,
          teacher_id: teacherId || null,
          visibility_scope: resolvedScope,
          created_by: req.user.id,
        })
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          visibility_scope,
          course_id,
          teacher_id,
          created_by,
          created_at,
          updated_at,
          course:course_id (
            id,
            name
          ),
          teacher:teacher_id (
            id,
            name
          ),
          creator:created_by (
            id,
            name,
            role
          )
        `
        )
        .single();

      if (insertError) {
        if (insertError.code === "42P01") {
          return res.status(500).json({
            message:
              "Admin notes table not found. Please run the provided SQL migration to create admin_notes.",
          });
        }

        throw insertError;
      }

      const io = req.app.get("io");
      io?.emit("admin-notes-refresh", {
        noteId: noteRow.id,
        courseId: noteRow.course_id,
        teacherId: noteRow.teacher_id,
      });

      res.status(201).json({
        message: "Note uploaded successfully",
        note: mapAdminManagedNote(noteRow),
      });
    } catch (error) {
      console.error("Create admin note error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/allTeachers",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data, error } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          status,
          metadata,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .eq("role", "teacher")
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      res.json((data ?? []).map(mapTeacher));
    } catch (error) {
      console.error("Fetch teachers error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/allStudents",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data, error } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          status,
          student_id,
          course_id,
          course:course_id (
            id,
            name
          )
        `
        )
        .eq("role", "student")
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      res.json((data ?? []).map(mapStudent));
    } catch (error) {
      console.error("Fetch students error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// PUT and DELETE routes must come before GET /courses to avoid route conflicts
router.put(
  "/courses/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;
      const { name, description, teacherId } = req.body;

      const { data: courseRow, error: fetchError } = await supabase
        .from("courses")
        .select("id, name, description, teacher_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!courseRow) {
        return res.status(404).json({ message: "Course not found" });
      }

      const updates = {};

      if (name) {
        updates.name = name;
      }

      if (description !== undefined) {
        updates.description = description || "";
      }

      if (teacherId !== undefined) {
        if (teacherId) {
          const { data: teacherRow, error: teacherError } = await supabase
            .from("users")
            .select("id, course_id")
            .eq("id", teacherId)
            .eq("role", "teacher")
            .maybeSingle();

          if (teacherError) {
            throw teacherError;
          }

          if (!teacherRow) {
            return res.status(404).json({ message: "Teacher not found" });
          }

          // Remove teacher from previous course if assigned
          if (teacherRow.course_id && teacherRow.course_id !== id) {
            await supabase
              .from("courses")
              .update({ teacher_id: null })
              .eq("id", teacherRow.course_id);
          }

          updates.teacher_id = teacherId;

          // Update teacher's course_id
          await supabase
            .from("users")
            .update({ course_id: id })
            .eq("id", teacherId);
        } else {
          updates.teacher_id = null;
        }

        // Remove previous teacher's course_id if changed
        if (courseRow.teacher_id && courseRow.teacher_id !== teacherId) {
          await supabase
            .from("users")
            .update({ course_id: null })
            .eq("id", courseRow.teacher_id);
        }
      }

      const { data: updatedCourse, error: updateError } = await supabase
        .from("courses")
        .update(updates)
        .eq("id", id)
        .select(
          `
          id,
          name,
          description,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          ),
          enrollments:course_students (
            student:users!course_students_student_id_fkey (
              id,
              name,
              email,
              student_id,
              status
            )
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");
      if (io) {
        io.emit("course-updated", { courseId: id });
      }

      res.json({
        message: "Course updated successfully",
        course: mapCourse(updatedCourse),
      });
    } catch (error) {
      console.error("Update course error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/courses/:id",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { id } = req.params;

      const { data: courseRow, error: fetchError } = await supabase
        .from("courses")
        .select("id, teacher_id")
        .eq("id", id)
        .maybeSingle();

      if (fetchError) {
        throw fetchError;
      }

      if (!courseRow) {
        return res.status(404).json({ message: "Course not found" });
      }

      // Delete all enrollments
      await supabase
        .from("course_students")
        .delete()
        .eq("course_id", id);

      // Remove course_id from teacher if assigned
      if (courseRow.teacher_id) {
        await supabase
          .from("users")
          .update({ course_id: null })
          .eq("id", courseRow.teacher_id);
      }

      // Remove course_id from all students
      await supabase
        .from("users")
        .update({ course_id: null })
        .eq("course_id", id);

      // Delete the course
      const { error: deleteError } = await supabase
        .from("courses")
        .delete()
        .eq("id", id);

      if (deleteError) {
        throw deleteError;
      }

      await emitAdminSnapshot(req);

      const io = req.app.get("io");
      if (io) {
        io.emit("course-deleted", { courseId: id });
      }

      res.json({ message: "Course deleted successfully" });
    } catch (error) {
      console.error("Delete course error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/courses",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data, error } = await supabase
        .from("courses")
        .select(
          `
          id,
          name,
          description,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          ),
          enrollments:course_students (
            student:users!course_students_student_id_fkey (
              id,
              name,
              email,
              student_id,
              status
            )
          )
        `
        )
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      res.json((data ?? []).map(mapCourse));
    } catch (error) {
      console.error("Fetch courses error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Avatar upload endpoint for admin profile (must be before /settings/profile routes)
router.post(
  "/settings/avatar",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { fileData, fileName: originalFileName, fileType } = req.body;
      
      if (!fileData) {
        return res.status(400).json({ message: "No file data provided" });
      }

      // Handle base64 encoded file (data URL format: data:mime/type;base64,base64data)
      let fileBuffer;
      let mimeType = fileType || 'image/jpeg';
      
      if (typeof fileData === 'string' && fileData.startsWith('data:')) {
        // Base64 data URL: data:mime/type;base64,base64data
        const base64Match = fileData.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          mimeType = base64Match[1];
          const base64Data = base64Match[2];
          fileBuffer = Buffer.from(base64Data, 'base64');
        } else {
          // Fallback: try to extract base64 after comma
          const parts = fileData.split(',');
          if (parts.length > 1) {
            fileBuffer = Buffer.from(parts[1], 'base64');
            const mimeMatch = fileData.match(/data:([^;]+)/);
            if (mimeMatch) {
              mimeType = mimeMatch[1];
            }
          } else {
            return res.status(400).json({ message: "Invalid file data format" });
          }
        }
      } else if (typeof fileData === 'string') {
        // Plain base64 string
        fileBuffer = Buffer.from(fileData, 'base64');
      } else {
        return res.status(400).json({ message: "Invalid file data format" });
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        return res.status(400).json({ message: "File data is empty" });
      }

      const fileExt = originalFileName?.split('.').pop() || mimeType.split('/')[1] || 'jpg';
      const userId = req.user.id;
      const fileName = `${userId}/avatar-${Date.now()}.${fileExt}`;

      // Upload to Supabase storage using service role key (bypasses RLS)
      const { data, error } = await supabase.storage
        .from('student-avatars')
        .upload(fileName, fileBuffer, {
          contentType: mimeType,
          cacheControl: '3600',
          upsert: true, // Allow overwriting existing avatar
        });

      if (error) {
        console.error('Avatar upload error:', error);
        return res.status(500).json({ 
          message: 'Failed to upload avatar to storage',
          error: error.message 
        });
      }

      const { data: { publicUrl } } = supabase.storage
        .from('student-avatars')
        .getPublicUrl(fileName);

      res.json({
        message: 'Avatar uploaded successfully',
        avatarUrl: publicUrl,
        fileName: fileName,
      });
    } catch (error) {
      console.error('Upload avatar error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

router.get(
  "/settings/profile",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      // Try to fetch admin with custom roles, but fallback if tables don't exist
      let { data: adminRow, error: adminError } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .eq("id", req.user.id)
        .maybeSingle();

      // If query fails due to missing custom_roles tables, try simpler query
      if (adminError && (adminError.code === "42P01" || adminError.message?.includes("does not exist") || adminError.message?.includes("relation"))) {
        console.warn("Custom roles tables not found, fetching admin without roles:", adminError.message);
        const simpleQuery = await supabase
          .from("users")
          .select("id, name, email, role, status, metadata, created_at, updated_at")
          .eq("id", req.user.id)
          .maybeSingle();
        
        if (simpleQuery.error) {
          throw simpleQuery.error;
        }
        
        adminRow = simpleQuery.data ? { ...simpleQuery.data, custom_roles: [] } : null;
        adminError = null;
      }

      if (adminError) {
        throw adminError;
      }

      if (!adminRow) {
        return res.status(404).json({ message: "Admin not found" });
      }

      let lastLoginAt = null;
      let preferencesRow = null;

      try {
        lastLoginAt = await fetchLastLoginAt(req.user.id);
        preferencesRow = await getNotificationPreferences(req.user.id);
      } catch (prefError) {
        console.error("Error fetching preferences or activity:", prefError);
        preferencesRow = {
          admin_id: req.user.id,
          auto_grade_updates: false,
          auto_attendance_changes: false,
          auto_assignment_uploads: false,
          channels: ["in_app"],
        };
      }

      const profile = mapAdminAccount({
        ...adminRow,
        last_login_at: lastLoginAt,
      });

      res.json({
        profile,
        preferences: {
          autoGradeUpdates: preferencesRow.auto_grade_updates ?? false,
          autoAttendanceChanges:
            preferencesRow.auto_attendance_changes ?? false,
          autoAssignmentUploads:
            preferencesRow.auto_assignment_uploads ?? false,
          channels: normalizeChannels(preferencesRow.channels ?? ["in_app"]),
          updatedAt: preferencesRow.updated_at ?? null,
        },
      });
    } catch (error) {
      console.error("Fetch admin profile error:", error);
      // Return a basic profile structure instead of 500 error
      res.json({
        profile: {
          id: req.user.id,
          name: req.user.name || "Admin",
          email: req.user.email || "",
          role: req.user.role || "admin",
          status: req.user.status || "active",
          avatarUrl: null,
          metadata: {},
          customRoles: [],
          lastLoginAt: null,
        },
        preferences: {
          autoGradeUpdates: false,
          autoAttendanceChanges: false,
          autoAssignmentUploads: false,
          channels: ["in_app"],
          updatedAt: null,
        },
      });
    }
  }
);

router.put(
  "/settings/profile",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const {
      name,
      email,
      password,
      avatarUrl,
      metadata = {},
      preferences,
    } = req.body ?? {};

    try {
      const { data: current, error: currentError } = await supabase
        .from("users")
        .select("id, email, metadata")
        .eq("id", req.user.id)
        .maybeSingle();

      if (currentError) {
        throw currentError;
      }

      if (!current) {
        return res.status(404).json({ message: "Admin not found" });
      }

      const updates = {};

      if (name?.trim()) {
        updates.name = name.trim();
      }

      if (email?.trim() && email.trim().toLowerCase() !== current.email) {
        const normalizedEmail = email.trim().toLowerCase();

        const { data: emailRow, error: emailError } = await supabase
          .from("users")
          .select("id")
          .eq("email", normalizedEmail)
          .neq("id", req.user.id)
          .maybeSingle();

        if (emailError) {
          throw emailError;
        }

        if (emailRow) {
          return res
            .status(409)
            .json({ message: "Email is already associated with another user" });
        }

        updates.email = normalizedEmail;
      }

      if (password?.trim()) {
        updates.password_hash = await bcrypt.hash(password.trim(), 10);
      }

      const mergedMetadata = {
        ...(current.metadata ?? {}),
        ...(metadata && typeof metadata === "object" ? metadata : {}),
      };

      if (avatarUrl?.trim()) {
        mergedMetadata.avatarUrl = avatarUrl.trim();
      }

      updates.metadata = mergedMetadata;

      if (Object.keys(updates).length === 0) {
        return res
          .status(400)
          .json({ message: "No valid fields provided for update" });
      }

      const { data: updated, error: updateError } = await supabase
        .from("users")
        .update(updates)
        .eq("id", req.user.id)
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      let preferencesRow = await getNotificationPreferences(req.user.id);

      if (preferences && typeof preferences === "object") {
        preferencesRow = await upsertNotificationPreferences(req.user.id, {
          autoGradeUpdates: preferences.autoGradeUpdates,
          autoAttendanceChanges: preferences.autoAttendanceChanges,
          autoAssignmentUploads: preferences.autoAssignmentUploads,
          channels: normalizeChannels(preferences.channels),
        });
      }

      const lastLoginAt = await fetchLastLoginAt(req.user.id);

      const profile = mapAdminAccount({
        ...updated,
        last_login_at: lastLoginAt,
      });

      res.json({
        message: "Profile updated successfully",
        profile,
        preferences: {
          autoGradeUpdates: preferencesRow.auto_grade_updates ?? false,
          autoAttendanceChanges:
            preferencesRow.auto_attendance_changes ?? false,
          autoAssignmentUploads:
            preferencesRow.auto_assignment_uploads ?? false,
          channels: normalizeChannels(preferencesRow.channels ?? ["in_app"]),
          updatedAt: preferencesRow.updated_at ?? null,
        },
      });
    } catch (error) {
      console.error("Update admin profile error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /admin/enrollments/pending - Get all pending enrollments (where student_id is null)
router.get(
  "/enrollments/pending",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      // Fetch all enrollments where student_id is NULL
      const { data: enrollments, error } = await supabase
        .from("course_students")
        .select(
          `
          id,
          course_id,
          student_id,
          student_name,
          student_email,
          student_phone,
          course_name,
          created_at,
          course:course_id (
            id,
            name
          )
        `
        )
        .is("student_id", null)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Error fetching pending enrollments:", error);
        throw error;
      }

      // Map the enrollments to a cleaner format
      const mappedEnrollments = (enrollments || []).map((enrollment) => ({
        id: enrollment.id,
        enrollmentId: enrollment.id, // For reference
        name: enrollment.student_name,
        email: enrollment.student_email,
        phone: enrollment.student_phone,
        courseId: enrollment.course_id,
        courseName: enrollment.course_name || enrollment.course?.name || "Unknown Course",
        createdAt: enrollment.created_at,
      }));

      res.json(mappedEnrollments);
    } catch (error) {
      console.error("Get pending enrollments error:", error);
      res.status(500).json({
        message: error.message || "Failed to fetch pending enrollments",
      });
    }
  }
);

router.get(
  "/settings/activity",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const requestedAdminId =
        req.query.adminId && req.user.role === "super_admin"
          ? String(req.query.adminId)
          : req.user.id;

      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 20, 1),
        200
      );

      const { data, error } = await supabase
        .from("admin_activity_logs")
        .select(
          `
          id,
          admin_id,
          event_type,
          ip_address,
          user_agent,
          metadata,
          created_at
        `
        )
        .eq("admin_id", requestedAdminId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        if (error.code === "42P01") {
          console.warn("admin_activity_logs table not found, returning empty array");
          return res.json({ logs: [] });
        }
        throw error;
      }

      res.json({
        adminId: requestedAdminId,
        activity: (data ?? []).map((row) => ({
          id: row.id,
          eventType: row.event_type || "login",
          ipAddress: row.ip_address ?? null,
          userAgent: row.user_agent ?? null,
          metadata: row.metadata ?? {},
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      console.error("Fetch admin activity error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/settings/admins",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      // Try to fetch admins with custom roles, but fallback if tables don't exist
      let { data: adminRows, error } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .in("role", ADMIN_ROLES)
        .order("created_at", { ascending: true });

      // If query fails due to missing custom_roles tables, try simpler query
      if (error && (error.code === "42P01" || error.message?.includes("does not exist") || error.message?.includes("relation"))) {
        console.warn("Custom roles tables not found, fetching admins without roles:", error.message);
        const simpleQuery = await supabase
          .from("users")
          .select("id, name, email, role, status, metadata, created_at, updated_at")
          .in("role", ADMIN_ROLES)
          .order("created_at", { ascending: true });
        
        if (simpleQuery.error) {
          throw simpleQuery.error;
        }
        
        adminRows = (simpleQuery.data ?? []).map(row => ({ ...row, custom_roles: [] }));
        error = null;
      }

      if (error) {
        throw error;
      }

      if (!adminRows?.length) {
        return res.json([]);
      }

      const adminIds = adminRows.map((row) => row.id);

      // Try to fetch last login times, but handle missing table gracefully
      let lastLoginMap = new Map();
      try {
        const { data: loginRows, error: loginError } = await supabase
          .from("admin_activity_logs")
          .select("admin_id, created_at")
          .in("admin_id", adminIds)
          .order("created_at", { ascending: false });

        if (loginError) {
          if (loginError.code === "42P01") {
            console.warn("admin_activity_logs table not found, skipping last login fetch");
          } else {
            throw loginError;
          }
        } else {
          // Group by admin_id and get the most recent login
          const loginMap = new Map();
          (loginRows ?? []).forEach((row) => {
            const existing = loginMap.get(row.admin_id);
            if (!existing || new Date(row.created_at) > new Date(existing)) {
              loginMap.set(row.admin_id, row.created_at);
            }
          });
          lastLoginMap = loginMap;
        }
      } catch (loginErr) {
        console.warn("Error fetching last login times:", loginErr.message);
      }

      const admins = adminRows.map((row) =>
        mapAdminAccount({
          ...row,
          last_login_at: lastLoginMap.get(row.id) ?? null,
        })
      );

      res.json(admins);
    } catch (error) {
      console.error("Fetch admin accounts error:", error);
      res.json([]); // Return empty array instead of 500 error
    }
  }
);

router.post(
  "/settings/admins",
  protect,
  requireAdminRole,
  requireWriteAccess,
  canManageAdmin,
  async (req, res) => {
    try {
      if (!guardSupabase(res)) {
        return;
      }

      console.log(`[CREATE ADMIN] Request from user: ${req.user?.email} (${req.user?.role})`);
      console.log(`[CREATE ADMIN] Request body:`, JSON.stringify(req.body, null, 2));

    // Support both 'name' and 'fullName' for backward compatibility
    const {
      name,
      fullName,
      email,
      password,
      role = "co_admin",
      metadata = {},
      customRoleIds = [],
    } = req.body ?? {};

    // Validation errors object
    const validationErrors = {};

    // Validate fullName/name
    const adminName = (name || fullName)?.trim();
    if (!adminName) {
      validationErrors.fullName = "Full name is required";
    } else if (adminName.length < 2) {
      validationErrors.fullName = "Full name must be at least 2 characters";
    }

    // Validate email
    const emailValue = email?.trim();
    if (!emailValue) {
      validationErrors.email = "Email is required";
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailValue)) {
        validationErrors.email = "Please enter a valid email address";
      }
    }

    // Validate password (if provided)
    const passwordValue = password?.trim();
    if (passwordValue && passwordValue.length < 8) {
      validationErrors.password = "Password must be at least 8 characters long";
    }

    // Validate role
    const roleValue = role?.trim();
    if (!roleValue) {
      validationErrors.role = "Role is required";
    } else if (!ADMIN_ROLES.includes(roleValue)) {
      validationErrors.role = `Role must be one of: ${ADMIN_ROLES.join(", ")}`;
    }

    // Return validation errors if any
    if (Object.keys(validationErrors).length > 0) {
      console.log(`[CREATE ADMIN] Validation failed:`, validationErrors);
      return res.status(400).json({
        message: "Validation failed",
        errors: validationErrors,
        code: "VALIDATION_ERROR"
      });
    }

    // Normalize role
    const normalizedRole = ADMIN_ROLES.includes(roleValue)
      ? roleValue
      : "co_admin";

    // Both admin and super_admin can create any admin role
    // This check is handled by canManageAdmin middleware, so no additional check needed here

    const normalizedEmail = emailValue.toLowerCase();

      // Check for existing email
      const { data: existing, error: existingError } = await supabase
        .from("users")
        .select("id, email")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (existingError) {
        console.error("[CREATE ADMIN] Database error checking email:", existingError);
        throw existingError;
      }

      if (existing) {
        console.log(`[CREATE ADMIN] Email already exists: ${normalizedEmail}`);
        return res.status(409).json({
          message: "Email already exists",
          errors: { email: "This email is already associated with an account" },
          code: "EMAIL_EXISTS"
        });
      }

      // Handle password
      let passwordToUse = passwordValue;
      let generatedPassword = null;

      if (!passwordToUse) {
        generatedPassword = generateRandomPassword();
        passwordToUse = generatedPassword;
        console.log(`[CREATE ADMIN] Generated password for: ${normalizedEmail}`);
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(passwordToUse, 10);

      // Prepare metadata
      const metadataPayload =
        metadata && typeof metadata === "object" ? metadata : {};

      // Insert admin user
      const { data: inserted, error: insertError } = await supabase
        .from("users")
        .insert({
          name: adminName,
          email: normalizedEmail,
          role: normalizedRole,
          status: "active",
          metadata: metadataPayload,
          password_hash: hashedPassword,
        })
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .single();

      if (insertError) {
        console.error("[CREATE ADMIN] Insert error:", insertError);
        console.error("[CREATE ADMIN] Error code:", insertError.code);
        console.error("[CREATE ADMIN] Error message:", insertError.message);
        console.error("[CREATE ADMIN] Error details:", insertError.details);
        console.error("[CREATE ADMIN] Error hint:", insertError.hint);
        
        // Handle specific database errors
        
        // Duplicate email error
        if (insertError.code === "23505" || 
            insertError.message?.includes("duplicate") || 
            insertError.message?.includes("unique") ||
            insertError.message?.includes("already exists")) {
          return res.status(409).json({
            message: "Email already exists",
            errors: { email: "This email is already associated with an account" },
            code: "EMAIL_EXISTS"
          });
        }
        
        // Enum value error - role not supported
        if (insertError.code === "22P02" || 
            insertError.message?.includes("invalid input value for enum") ||
            insertError.message?.includes("invalid enum value") ||
            insertError.message?.toLowerCase().includes("user_role")) {
          return res.status(400).json({
            message: "Invalid role value",
            errors: { 
              role: `The role '${normalizedRole}' is not supported. Please run FIX_USERS_TABLE_FOR_ADMIN_ROLES.sql in Supabase to add support for admin roles.` 
            },
            code: "INVALID_ROLE_ENUM",
            hint: "The database role enum needs to be updated to include 'co_admin' and 'super_admin'"
          });
        }
        
        // Not null constraint violation
        if (insertError.code === "23502" || insertError.message?.includes("null value")) {
          const column = insertError.column || "unknown";
          return res.status(400).json({
            message: "Required field missing",
            errors: { [column]: `The ${column} field is required` },
            code: "MISSING_REQUIRED_FIELD"
          });
        }
        
        // Foreign key constraint violation
        if (insertError.code === "23503") {
          return res.status(400).json({
            message: "Invalid reference",
            errors: { general: insertError.message || "Referenced record does not exist" },
            code: "FOREIGN_KEY_VIOLATION"
          });
        }

        // Re-throw for other errors to be caught by outer catch
        throw insertError;
      }

      if (!inserted) {
        throw new Error("Failed to create admin account - no data returned");
      }

      // Sync custom roles (handle gracefully if table doesn't exist)
      let customRoleList = [];
      try {
        customRoleList = await syncUserCustomRoles(
          inserted.id,
          Array.isArray(customRoleIds) ? customRoleIds : []
        );
      } catch (roleError) {
        console.warn("[CREATE ADMIN] Custom roles sync failed (non-critical):", roleError.message);
        // Continue without custom roles
      }

      const profile = mapAdminAccount({
        ...inserted,
        custom_roles: customRoleList,
        last_login_at: null,
      });

      console.log(`[CREATE ADMIN] Successfully created admin: ${normalizedEmail} (${normalizedRole})`);

      res.status(201).json({
        message: "Admin account created successfully",
        profile,
        temporaryPassword: generatedPassword,
      });
    } catch (error) {
      console.error("[CREATE ADMIN] Unexpected error:", error);
      console.error("[CREATE ADMIN] Error message:", error?.message);
      console.error("[CREATE ADMIN] Error code:", error?.code);
      console.error("[CREATE ADMIN] Error details:", error?.details);
      console.error("[CREATE ADMIN] Error hint:", error?.hint);
      console.error("[CREATE ADMIN] Error stack:", error?.stack);
      
      // Return safe error message
      if (!res.headersSent) {
        res.status(500).json({
          message: "An unexpected error occurred while creating the admin account. Please try again.",
          code: "INTERNAL_SERVER_ERROR",
          ...(process.env.NODE_ENV === "development" && {
            error: error?.message || String(error),
            code: error?.code,
            details: error?.details,
            hint: error?.hint,
            stack: error?.stack
          })
        });
      }
    }
  }
);

router.put(
  "/settings/admins/:adminId",
  protect,
  requireAdminRole,
  requireWriteAccess,
  canManageAdmin,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { adminId } = req.params;
    const {
      name,
      email,
      role,
      status,
      metadata,
      customRoleIds,
    } = req.body ?? {};

    try {
      const { data: target, error: targetError } = await supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata
        `
        )
        .eq("id", adminId)
        .maybeSingle();

      if (targetError) {
        throw targetError;
      }

      if (!target || !ADMIN_ROLES.includes(target.role)) {
        return res.status(404).json({ message: "Admin account not found" });
      }

      // Both admin and super_admin can manage all admin accounts
      // No additional restriction needed - handled by canManageAdmin middleware

      const updates = {};

      if (name?.trim()) {
        updates.name = name.trim();
      }

      if (email?.trim() && email.trim().toLowerCase() !== target.email) {
        const normalizedEmail = email.trim().toLowerCase();

        const { data: existing, error: existingError } = await supabase
          .from("users")
          .select("id")
          .eq("email", normalizedEmail)
          .neq("id", adminId)
          .maybeSingle();

        if (existingError) {
          throw existingError;
        }

        if (existing) {
          return res
            .status(409)
            .json({ message: "Email is already associated with another user." });
        }

        updates.email = normalizedEmail;
      }

      if (status && ["active", "suspended"].includes(status)) {
        updates.status = status;
      }

      if (role) {
        const normalizedRole = ADMIN_ROLES.includes(role) ? role : target.role;

        // Both admin and super_admin can change admin roles
        // No restriction needed - handled by canManageAdmin middleware

        updates.role = normalizedRole;
      }

      if (metadata && typeof metadata === "object") {
        updates.metadata = {
          ...(target.metadata ?? {}),
          ...metadata,
        };
      }

      if (!Object.keys(updates).length && !Array.isArray(customRoleIds)) {
        return res
          .status(400)
          .json({ message: "No valid fields provided for update." });
      }

      const { data: updated, error: updateError } = await supabase
        .from("users")
        .update(updates)
        .eq("id", adminId)
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      let assignedRoles = updated.custom_roles ?? [];

      if (Array.isArray(customRoleIds)) {
        assignedRoles = await syncUserCustomRoles(adminId, customRoleIds);
      }

      const lastLoginAt = await fetchLastLoginAt(adminId);

      const profile = mapAdminAccount({
        ...updated,
        custom_roles: assignedRoles,
        last_login_at: lastLoginAt,
      });

      res.json({
        message: "Admin account updated successfully",
        profile,
      });
    } catch (error) {
      console.error("Update admin account error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.patch(
  "/settings/admins/:adminId/status",
  protect,
  requireAdminRole,
  requireWriteAccess,
  canManageAdmin,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { adminId } = req.params;
    const { status } = req.body ?? {};

    if (!["active", "suspended"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status must be either 'active' or 'suspended'." });
    }

    if (adminId === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot change the status of your own account." });
    }

    try {
      const { data: target, error: targetError } = await supabase
        .from("users")
        .select("id, role")
        .eq("id", adminId)
        .maybeSingle();

      if (targetError) {
        throw targetError;
      }

      if (!target || !ADMIN_ROLES.includes(target.role)) {
        return res.status(404).json({ message: "Admin account not found" });
      }

      // Both admin and super_admin can update all admin accounts
      // No additional restriction needed - handled by canManageAdmin middleware

      const { data: updated, error: updateError } = await supabase
        .from("users")
        .update({ status })
        .eq("id", adminId)
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          metadata,
          created_at,
          updated_at,
          custom_roles:user_custom_roles (
            role:custom_roles (
              id,
              name,
              description,
              permissions
            )
          )
        `
        )
        .single();

      if (updateError) {
        throw updateError;
      }

      const lastLoginAt = await fetchLastLoginAt(adminId);

      res.json({
        message: `Account ${status === "suspended" ? "suspended" : "reactivated"} successfully`,
        profile: mapAdminAccount({
          ...updated,
          last_login_at: lastLoginAt,
        }),
      });
    } catch (error) {
      console.error("Update admin status error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/settings/reset-password",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { userId, newPassword, autoGenerate } = req.body ?? {};

    if (!userId) {
      return res
        .status(400)
        .json({ message: "Target user ID is required for password reset." });
    }

    try {
      const { data: target, error: targetError } = await supabase
        .from("users")
        .select("id, role, status")
        .eq("id", userId)
        .maybeSingle();

      if (targetError) {
        throw targetError;
      }

      if (!target) {
        return res.status(404).json({ message: "User not found" });
      }

      // Both admin and super_admin can reset admin passwords
      // No restriction needed - handled by requireWriteAccess middleware

      let passwordToUse = newPassword?.trim();
      let generatedPassword = null;

      if (!passwordToUse) {
        if (!autoGenerate) {
          return res
            .status(400)
            .json({ message: "Provide a new password or enable autoGenerate." });
        }
        generatedPassword = generateRandomPassword();
        passwordToUse = generatedPassword;
      }

      const hashedPassword = await bcrypt.hash(passwordToUse, 10);

      const { error: updateError } = await supabase
        .from("users")
        .update({ password_hash: hashedPassword })
        .eq("id", userId);

      if (updateError) {
        throw updateError;
      }

      res.json({
        message: "Password reset successfully",
        temporaryPassword: generatedPassword,
      });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/settings/users/import",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { csv, defaultRole } = req.body ?? {};

    if (!csv?.trim()) {
      return res
        .status(400)
        .json({ message: "CSV payload is required for import." });
    }

    const rows = parseCsv(csv);

    if (!rows.length) {
      return res
        .status(400)
        .json({ message: "CSV contains no rows to import." });
    }

    const allowedRoles = new Set(["teacher", "student"]);
    const summary = [];

    try {
      for (const row of rows) {
        const name = row.name?.trim();
        const email = row.email?.trim()?.toLowerCase();
        const role =
          row.role?.trim()?.toLowerCase() ||
          defaultRole?.trim()?.toLowerCase() ||
          "student";
        const status = row.status?.trim()?.toLowerCase() || "active";
        const studentId = row.studentId?.trim() || row.student_id?.trim() || null;

        if (!email) {
          summary.push({
            email: null,
            status: "skipped",
            reason: "Missing email",
          });
          continue;
        }

        if (!allowedRoles.has(role)) {
          summary.push({
            email,
            status: "skipped",
            reason: `Unsupported role '${role}'. Expected teacher or student.`,
          });
          continue;
        }

        const { data: existing, error: existingError } = await supabase
          .from("users")
          .select("id, role, status")
          .eq("email", email)
          .maybeSingle();

        if (existingError) {
          throw existingError;
        }

        if (existing) {
          await supabase
            .from("users")
            .update({
              name: name || existing.name,
              status: status === "suspended" ? "suspended" : "active",
              student_id: role === "student" ? studentId : null,
            })
            .eq("id", existing.id);

          summary.push({
            email,
            status: "updated",
            role,
          });
          continue;
        }

        const password = generateRandomPassword();
        const hashedPassword = await bcrypt.hash(password, 10);

        const { data: inserted, error: insertError } = await supabase
          .from("users")
          .insert({
            name: name || email.split("@")[0],
            email,
            role,
            status: status === "suspended" ? "suspended" : "active",
            student_id: role === "student" ? studentId : null,
            password_hash: hashedPassword,
            metadata: {},
          })
          .select("id")
          .single();

        if (insertError) {
          summary.push({
            email,
            status: "failed",
            reason: insertError.message,
          });
          continue;
        }

        summary.push({
          email,
          status: "created",
          role,
          temporaryPassword: password,
          userId: inserted?.id ?? null,
        });
      }

      res.json({
        message: "Import completed",
        results: summary,
      });
    } catch (error) {
      console.error("Import users error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/settings/users/export",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const rolesParam = req.query.roles
        ? String(req.query.roles)
            .split(",")
            .map((role) => role.trim().toLowerCase())
            .filter(Boolean)
        : ["teacher", "student"];

      const roles = rolesParam.filter((role) =>
        ["teacher", "student"].includes(role)
      );

      const builder = supabase
        .from("users")
        .select(
          `
          id,
          name,
          email,
          role,
          status,
          student_id,
          metadata,
          created_at
        `
        )
        .order("created_at", { ascending: true });

      if (roles.length) {
        builder.in("role", roles);
      } else {
        builder.in("role", ["teacher", "student"]);
      }

      const { data, error } = await builder;

      if (error) {
        throw error;
      }

      const headers = [
        "name",
        "email",
        "role",
        "status",
        "studentId",
        "metadata",
        "createdAt",
      ];

      const csvContent = stringifyCsv(
        headers,
        (data ?? []).map((row) => ({
          name: row.name ?? "",
          email: row.email,
          role: row.role,
          status: row.status,
          studentId: row.student_id ?? "",
          metadata: JSON.stringify(row.metadata ?? {}),
          createdAt: row.created_at,
        }))
      );

      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="users-export-${Date.now()}.csv"`
      );
      res.send(csvContent);
    } catch (error) {
      console.error("Export users error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/settings/roles",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data, error } = await supabase
        .from("custom_roles")
        .select(
          `
          id,
          name,
          description,
          permissions,
          created_by,
          created_at,
          updated_at
        `
        )
        .order("created_at", { ascending: true });

      if (error) {
        if (error.code === "42P01") {
          console.warn("custom_roles table not found, returning empty array");
          return res.json([]);
        }
        throw error;
      }

      res.json(
        (data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description ?? "",
          permissions: row.permissions ?? {},
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }))
      );
    } catch (error) {
      console.error("Fetch custom roles error:", error);
      res.json([]); // Return empty array instead of 500 error
    }
  }
);

router.post(
  "/settings/roles",
  protect,
  requireAdminRole,
  requireWriteAccess,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    // Both admin and super_admin can create custom roles
    // Check handled by requireWriteAccess middleware

    const { name, description, permissions } = req.body ?? {};

    if (!name?.trim()) {
      return res.status(400).json({ message: "Role name is required." });
    }

    try {
      const { data: inserted, error } = await supabase
        .from("custom_roles")
        .insert({
          name: name.trim(),
          description: description ?? "",
          permissions:
            permissions && typeof permissions === "object" ? permissions : {},
          created_by: req.user.id,
        })
        .select(
          `
          id,
          name,
          description,
          permissions,
          created_by,
          created_at,
          updated_at
        `
        )
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({
        message: "Custom role created successfully",
        role: {
          id: inserted.id,
          name: inserted.name,
          description: inserted.description ?? "",
          permissions: inserted.permissions ?? {},
          createdBy: inserted.created_by,
          createdAt: inserted.created_at,
          updatedAt: inserted.updated_at,
        },
      });
    } catch (error) {
      console.error("Create custom role error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/settings/roles/:roleId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    // Both admin and super_admin can update custom roles
    // Check handled by requireWriteAccess middleware

    const { roleId } = req.params;
    const { name, description, permissions } = req.body ?? {};

    const updates = {};

    if (name?.trim()) {
      updates.name = name.trim();
    }

    if (description !== undefined) {
      updates.description = description ?? "";
    }

    if (permissions && typeof permissions === "object") {
      updates.permissions = permissions;
    }

    if (!Object.keys(updates).length) {
      return res
        .status(400)
        .json({ message: "No valid fields provided for update." });
    }

    try {
      const { data: updated, error } = await supabase
        .from("custom_roles")
        .update(updates)
        .eq("id", roleId)
        .select(
          `
          id,
          name,
          description,
          permissions,
          created_by,
          created_at,
          updated_at
        `
        )
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!updated) {
        return res.status(404).json({ message: "Role not found" });
      }

      res.json({
        message: "Custom role updated successfully",
        role: {
          id: updated.id,
          name: updated.name,
          description: updated.description ?? "",
          permissions: updated.permissions ?? {},
          createdBy: updated.created_by,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      });
    } catch (error) {
      console.error("Update custom role error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/settings/roles/:roleId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    // Both admin and super_admin can delete custom roles
    // Check handled by requireWriteAccess middleware

    const { roleId } = req.params;

    try {
      await supabase.from("user_custom_roles").delete().eq("custom_role_id", roleId);

      const { error } = await supabase
        .from("custom_roles")
        .delete()
        .eq("id", roleId);

      if (error) {
        throw error;
      }

      res.json({ message: "Custom role deleted successfully" });
    } catch (error) {
      console.error("Delete custom role error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/settings/notifications/templates",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data, error } = await supabase
        .from("notification_templates")
        .select(
          `
          id,
          name,
          title,
          message,
          channels,
          audience_scope,
          created_by,
          created_at,
          updated_at
        `
        )
        .order("created_at", { ascending: true });

      if (error) {
        if (error.code === "42P01") {
          console.warn("notification_templates table not found, returning empty array");
          return res.json([]);
        }
        throw error;
      }

      res.json(
        (data ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          title: row.title,
          message: row.message,
          channels: normalizeChannels(row.channels ?? ["in_app"]),
          audienceScope: row.audience_scope ?? "custom",
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }))
      );
    } catch (error) {
      console.error("Fetch notification templates error:", error);
      res.json([]); // Return empty array instead of 500 error
    }
  }
);

router.post(
  "/settings/notifications/templates",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { name, title, message, channels, audienceScope } = req.body ?? {};

    if (!name?.trim() || !title?.trim() || !message?.trim()) {
      return res.status(400).json({
        message: "Template name, title, and message are required.",
      });
    }

    try {
      const { data: inserted, error } = await supabase
        .from("notification_templates")
        .insert({
          name: name.trim(),
          title: title.trim(),
          message: message.trim(),
          channels: normalizeChannels(channels),
          audience_scope: audienceScope ?? "custom",
          created_by: req.user.id,
        })
        .select(
          `
          id,
          name,
          title,
          message,
          channels,
          audience_scope,
          created_by,
          created_at,
          updated_at
        `
        )
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({
        message: "Notification template created successfully",
        template: {
          id: inserted.id,
          name: inserted.name,
          title: inserted.title,
          message: inserted.message,
          channels: normalizeChannels(inserted.channels ?? ["in_app"]),
          audienceScope: inserted.audience_scope ?? "custom",
          createdBy: inserted.created_by,
          createdAt: inserted.created_at,
          updatedAt: inserted.updated_at,
        },
      });
    } catch (error) {
      console.error("Create notification template error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.put(
  "/settings/notifications/templates/:templateId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { templateId } = req.params;
    const { name, title, message, channels, audienceScope } = req.body ?? {};

    const updates = {};

    if (name?.trim()) {
      updates.name = name.trim();
    }

    if (title?.trim()) {
      updates.title = title.trim();
    }

    if (message?.trim()) {
      updates.message = message.trim();
    }

    if (channels) {
      updates.channels = normalizeChannels(channels);
    }

    if (audienceScope) {
      updates.audience_scope = audienceScope;
    }

    if (!Object.keys(updates).length) {
      return res
        .status(400)
        .json({ message: "No valid fields provided for update." });
    }

    try {
      const { data: updated, error } = await supabase
        .from("notification_templates")
        .update(updates)
        .eq("id", templateId)
        .select(
          `
          id,
          name,
          title,
          message,
          channels,
          audience_scope,
          created_by,
          created_at,
          updated_at
        `
        )
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!updated) {
        return res.status(404).json({ message: "Template not found" });
      }

      res.json({
        message: "Template updated successfully",
        template: {
          id: updated.id,
          name: updated.name,
          title: updated.title,
          message: updated.message,
          channels: normalizeChannels(updated.channels ?? ["in_app"]),
          audienceScope: updated.audience_scope ?? "custom",
          createdBy: updated.created_by,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      });
    } catch (error) {
      console.error("Update notification template error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/settings/notifications/templates/:templateId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { templateId } = req.params;

    try {
      const { error } = await supabase
        .from("notification_templates")
        .delete()
        .eq("id", templateId);

      if (error) {
        throw error;
      }

      res.json({ message: "Template deleted successfully" });
    } catch (error) {
      console.error("Delete notification template error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.patch(
  "/settings/notifications/preferences",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { autoGradeUpdates, autoAttendanceChanges, autoAssignmentUploads, channels } =
      req.body ?? {};

    try {
      const preferencesRow = await upsertNotificationPreferences(req.user.id, {
        autoGradeUpdates,
        autoAttendanceChanges,
        autoAssignmentUploads,
        channels: normalizeChannels(channels),
      });

      res.json({
        message: "Notification preferences updated",
        preferences: {
          autoGradeUpdates: preferencesRow.auto_grade_updates ?? false,
          autoAttendanceChanges: preferencesRow.auto_attendance_changes ?? false,
          autoAssignmentUploads:
            preferencesRow.auto_assignment_uploads ?? false,
          channels: normalizeChannels(preferencesRow.channels ?? ["in_app"]),
          updatedAt: preferencesRow.updated_at ?? null,
        },
      });
    } catch (error) {
      console.error("Update notification preferences error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/settings/notifications/send",
  protect,
  requireAdminRole,
  requireWriteAccess,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    const { title, message, type = "general", audience, channels, metadata } =
      req.body ?? {};

    if (!title?.trim() || !message?.trim()) {
      return res
        .status(400)
        .json({ message: "Notification title and message are required." });
    }

    try {
      const recipientIds = Array.from(
        new Set(await fetchRecipientsForAudience(audience))
      );

      if (!recipientIds.length) {
        return res.status(400).json({
          message:
            "No recipients matched the selected audience. Adjust your filters and try again.",
        });
      }

      const payload = recipientIds.map((recipientId) => ({
        recipient_id: recipientId,
        title: title.trim(),
        message: message.trim(),
        type,
        channels: normalizeChannels(channels),
        sender_id: req.user.id,
        metadata:
          metadata && typeof metadata === "object" ? metadata : {},
        audience_scope: audience?.scope ?? "custom",
        course_id: audience?.courseId || null,
        section: audience?.section || null,
      }));

      const { data: inserted, error } = await supabase
        .from("notifications")
        .insert(payload)
        .select(
          `
          id,
          recipient_id,
          title,
          message,
          type,
          channels,
          metadata,
          created_at,
          sender:sender_id (
            id,
            name,
            email
          )
        `
        );

      if (error) {
        throw error;
      }

      emitNotificationEvents(req, recipientIds, {
        type: "bulk",
        count: recipientIds.length,
      });

      res.json({
        message: "Notification(s) dispatched successfully",
        recipients: recipientIds.length,
        records: inserted ?? [],
      });
    } catch (error) {
      console.error("Send notifications error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

router.get(
  "/stats",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const [teacherCount, studentCount, courseCount] = await Promise.all([
        countRows("users", { column: "role", value: "teacher" }),
        countRows("users", { column: "role", value: "student" }),
        countRows("courses"),
      ]);

      res.json({ teacherCount, studentCount, courseCount });
    } catch (error) {
      console.error("Fetch stats error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /admin/activities - Fetch all activities from student and teacher portals
router.get(
  "/activities",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const limit = parseInt(req.query.limit) || 100;
      const activities = [];

      // 1. Fetch recent submissions (student activities)
      const { data: submissions, error: submissionsError } = await supabase
        .from("submissions")
        .select("id, assignment_id, student_id, status, marks, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!submissionsError && submissions && submissions.length > 0) {
        // Fetch related data separately
        const assignmentIds = [...new Set(submissions.map(s => s.assignment_id).filter(Boolean))];
        const studentIds = [...new Set(submissions.map(s => s.student_id).filter(Boolean))];
        
        const assignmentMap = new Map();
        const studentMap = new Map();
        const courseMap = new Map();

        if (assignmentIds.length > 0) {
          const { data: assignmentsData } = await supabase
            .from("assignments")
            .select("id, title, course_id")
            .in("id", assignmentIds);
          
          if (assignmentsData) {
            assignmentsData.forEach(a => assignmentMap.set(a.id, a));
            
            const courseIds = [...new Set(assignmentsData.map(a => a.course_id).filter(Boolean))];
            if (courseIds.length > 0) {
              const { data: coursesData } = await supabase
                .from("courses")
                .select("id, name")
                .in("id", courseIds);
              
              if (coursesData) {
                coursesData.forEach(c => courseMap.set(c.id, c));
              }
            }
          }
        }

        if (studentIds.length > 0) {
          const { data: studentsData } = await supabase
            .from("users")
            .select("id, name, email, student_id")
            .in("id", studentIds)
            .eq("role", "student");
          
          if (studentsData) {
            studentsData.forEach(s => studentMap.set(s.id, s));
          }
        }

        submissions.forEach((sub) => {
          const assignment = assignmentMap.get(sub.assignment_id);
          const student = studentMap.get(sub.student_id);
          const course = assignment ? courseMap.get(assignment.course_id) : null;

          activities.push({
            id: `submission-${sub.id}`,
            type: "submission",
            portal: "student",
            title: `${student?.name || "Student"} submitted "${assignment?.title || "Assignment"}"`,
            description: course?.name ? `Course: ${course.name}` : null,
            user: student ? {
              id: student.id,
              name: student.name,
              email: student.email,
              studentId: student.student_id,
            } : null,
            metadata: {
              assignmentId: sub.assignment_id,
              assignmentTitle: assignment?.title,
              courseId: assignment?.course_id,
              courseName: course?.name,
              status: sub.status,
              marks: sub.marks,
            },
            timestamp: sub.created_at,
          });
        });
      }

      // 2. Fetch recent assignments (teacher activities)
      const { data: assignments, error: assignmentsError } = await supabase
        .from("assignments")
        .select(`
          id,
          title,
          description,
          course_id,
          created_by,
          created_at,
          updated_at,
          course:courses!assignments_course_id_fkey (
            id,
            name
          ),
          teacher:users!assignments_created_by_fkey (
            id,
            name,
            email
          )
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!assignmentsError && assignments) {
        assignments.forEach((assignment) => {
          activities.push({
            id: `assignment-${assignment.id}`,
            type: "assignment",
            portal: "teacher",
            title: `New assignment: "${assignment.title}"`,
            description: assignment.course?.name ? `Course: ${assignment.course.name}` : null,
            user: assignment.teacher ? {
              id: assignment.teacher.id,
              name: assignment.teacher.name,
              email: assignment.teacher.email,
            } : null,
            metadata: {
              assignmentId: assignment.id,
              assignmentTitle: assignment.title,
              courseId: assignment.course_id,
              courseName: assignment.course?.name,
            },
            timestamp: assignment.created_at,
          });
        });
      }

      // 3. Fetch recent attendance records (teacher activities)
      const { data: attendanceSessions, error: attendanceError } = await supabase
        .from("attendance")
        .select(`
          id,
          course_id,
          session_date,
          created_at,
          updated_at,
          course:courses!attendance_course_id_fkey (
            id,
            name,
            teacher_id,
            teacher:users!courses_teacher_id_fkey (
              id,
              name,
              email
            )
          )
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!attendanceError && attendanceSessions) {
        attendanceSessions.forEach((session) => {
          activities.push({
            id: `attendance-${session.id}`,
            type: "attendance",
            portal: "teacher",
            title: `Attendance marked for ${session.course?.name || "Course"}`,
            description: `Date: ${new Date(session.session_date).toLocaleDateString()}`,
            user: session.course?.teacher ? {
              id: session.course.teacher.id,
              name: session.course.teacher.name,
              email: session.course.teacher.email,
            } : null,
            metadata: {
              courseId: session.course_id,
              courseName: session.course?.name,
              sessionDate: session.session_date,
            },
            timestamp: session.created_at,
          });
        });
      }

      // 4. Fetch recent enrollments (system activities)
      const { data: enrollments, error: enrollmentsError } = await supabase
        .from("course_students")
        .select(`
          course_id,
          student_id,
          created_at,
          course:courses!course_students_course_id_fkey (
            id,
            name
          ),
          student:users!course_students_student_id_fkey (
            id,
            name,
            email,
            student_id
          )
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!enrollmentsError && enrollments) {
        enrollments.forEach((enrollment) => {
          activities.push({
            id: `enrollment-${enrollment.course_id}-${enrollment.student_id}`,
            type: "enrollment",
            portal: "system",
            title: `${enrollment.student?.name || "Student"} enrolled in ${enrollment.course?.name || "Course"}`,
            description: null,
            user: enrollment.student ? {
              id: enrollment.student.id,
              name: enrollment.student.name,
              email: enrollment.student.email,
              studentId: enrollment.student.student_id,
            } : null,
            metadata: {
              courseId: enrollment.course_id,
              courseName: enrollment.course?.name,
            },
            timestamp: enrollment.created_at,
          });
        });
      }

      // 5. Fetch recent resources/uploads (teacher/admin activities)
      const { data: resources, error: resourcesError } = await supabase
        .from("resources")
        .select(`
          id,
          title,
          type,
          course_id,
          uploaded_by,
          created_at,
          updated_at,
          course:courses!resources_course_id_fkey (
            id,
            name
          ),
          uploader:users!resources_uploaded_by_fkey (
            id,
            name,
            email,
            role
          )
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!resourcesError && resources) {
        resources.forEach((resource) => {
          activities.push({
            id: `resource-${resource.id}`,
            type: "resource",
            portal: resource.uploader?.role === "teacher" ? "teacher" : "admin",
            title: `${resource.uploader?.name || "User"} uploaded "${resource.title}"`,
            description: resource.course?.name ? `Course: ${resource.course.name}` : "Global resource",
            user: resource.uploader ? {
              id: resource.uploader.id,
              name: resource.uploader.name,
              email: resource.uploader.email,
            } : null,
            metadata: {
              resourceId: resource.id,
              resourceTitle: resource.title,
              resourceType: resource.type,
              courseId: resource.course_id,
              courseName: resource.course?.name,
            },
            timestamp: resource.created_at,
          });
        });
      }

      // 6. Fetch recent announcements (teacher/admin activities)
      const { data: announcements, error: announcementsError } = await supabase
        .from("announcements")
        .select(`
          id,
          title,
          body,
          course_id,
          created_by,
          pinned,
          created_at,
          updated_at,
          course:courses!announcements_course_id_fkey (
            id,
            name
          ),
          creator:users!announcements_created_by_fkey (
            id,
            name,
            email,
            role
          )
        `)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!announcementsError && announcements) {
        announcements.forEach((announcement) => {
          activities.push({
            id: `announcement-${announcement.id}`,
            type: "announcement",
            portal: announcement.creator?.role === "teacher" ? "teacher" : "admin",
            title: `New announcement: "${announcement.title}"`,
            description: announcement.course?.name ? `Course: ${announcement.course.name}` : "Global announcement",
            user: announcement.creator ? {
              id: announcement.creator.id,
              name: announcement.creator.name,
              email: announcement.creator.email,
            } : null,
            metadata: {
              announcementId: announcement.id,
              announcementTitle: announcement.title,
              courseId: announcement.course_id,
              courseName: announcement.course?.name,
              pinned: announcement.pinned,
            },
            timestamp: announcement.created_at,
          });
        });
      }

      // 7. Fetch schedule change requests (visible to all admins)
      const { data: scheduleRequests, error: scheduleRequestsError } = await supabase
        .from("schedule_change_requests")
        .select("id, slot_id, teacher_id, course_id, current_day_of_week, current_start_time, current_end_time, requested_day_of_week, requested_start_time, requested_end_time, reason, status, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!scheduleRequestsError && scheduleRequests && scheduleRequests.length > 0) {
        // Fetch related data separately
        const teacherIds = [...new Set(scheduleRequests.map(r => r.teacher_id).filter(Boolean))];
        const courseIds = [...new Set(scheduleRequests.map(r => r.course_id).filter(Boolean))];

        const teacherMap = new Map();
        const courseMap = new Map();

        if (teacherIds.length > 0) {
          const { data: teachers } = await supabase
            .from("users")
            .select("id, name, email, role")
            .in("id", teacherIds);
          
          if (teachers) {
            teachers.forEach(t => teacherMap.set(t.id, t));
          }
        }

        if (courseIds.length > 0) {
          const { data: courses } = await supabase
            .from("courses")
            .select("id, name")
            .in("id", courseIds);
          
          if (courses) {
            courses.forEach(c => courseMap.set(c.id, c));
          }
        }

        scheduleRequests.forEach((request) => {
          const teacher = teacherMap.get(request.teacher_id);
          const course = request.course_id ? courseMap.get(request.course_id) : null;

          const currentSlot = `${request.current_day_of_week || 'N/A'} ${request.current_start_time || ''}-${request.current_end_time || ''}`;
          const requestedSlot = `${request.requested_day_of_week || request.current_day_of_week || 'N/A'} ${request.requested_start_time || request.current_start_time || ''}-${request.requested_end_time || request.current_end_time || ''}`;

          activities.push({
            id: `schedule_request-${request.id}`,
            type: "schedule_change_request",
            portal: "teacher", // These are teacher activities (teachers submit the requests)
            title: "Schedule Change Request",
            description: teacher 
              ? `${teacher.name} requested a schedule change: From ${currentSlot} to ${requestedSlot}. Reason: ${request.reason || 'No reason provided'}`
              : `Schedule change requested: From ${currentSlot} to ${requestedSlot}. Reason: ${request.reason || 'No reason provided'}`,
            user: teacher ? {
              id: teacher.id,
              name: teacher.name,
              email: teacher.email,
            } : null,
            metadata: {
              notificationId: request.id, // Keep for backward compatibility
              requestId: request.id,
              slotId: request.slot_id,
              requestData: {
                slotId: request.slot_id,
                currentDayOfWeek: request.current_day_of_week,
                currentStartTime: request.current_start_time,
                currentEndTime: request.current_end_time,
                requestedDayOfWeek: request.requested_day_of_week,
                requestedStartTime: request.requested_start_time,
                requestedEndTime: request.requested_end_time,
                reason: request.reason,
              },
              courseId: request.course_id,
              courseName: course?.name,
            },
            timestamp: request.created_at,
          });
        });
      }

      // Sort all activities by timestamp (newest first)
      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Limit to requested number
      const limitedActivities = activities.slice(0, limit);

      res.json({ activities: limitedActivities, total: activities.length });
    } catch (error) {
      console.error("Fetch activities error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// POST /admin/schedule-change/:requestId/approve - Approve a schedule change request
router.post(
  "/schedule-change/:requestId/approve",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { requestId } = req.params;

      // Fetch the schedule change request
      const { data: request, error: requestError } = await supabase
        .from("schedule_change_requests")
        .select("*")
        .eq("id", requestId)
        .eq("status", "pending")
        .maybeSingle();

      if (requestError) {
        throw requestError;
      }

      if (!request) {
        return res.status(404).json({ message: "Schedule change request not found or already processed" });
      }

      // Update the slot with requested changes
      const updates = {};
      if (request.requested_day_of_week) {
        updates.day_of_week = request.requested_day_of_week;
      }
      if (request.requested_start_time) {
        updates.start_time = request.requested_start_time;
      }
      if (request.requested_end_time) {
        updates.end_time = request.requested_end_time;
      }

      // Even if no explicit changes, we still approve the request
      // (maybe they just wanted to request a change but keep same values)

      // Update the slot if there are changes
      if (Object.keys(updates).length > 0) {
        const { data: updatedSlot, error: updateError } = await supabase
          .from("teacher_schedule_slots")
          .update(updates)
          .eq("id", request.slot_id)
          .select("id, teacher_id, course_id, day_of_week, start_time, end_time, location, notes")
          .single();

        if (updateError) {
          console.error("[Approve Schedule Change] Error updating slot:", updateError);
          throw updateError;
        }

        // Sync to course_schedule_slots so students see the change
        // Pass old values so we can find and update the correct course slot
        const oldValues = {
          day_of_week: request.current_day_of_week,
          start_time: request.current_start_time,
          end_time: request.current_end_time,
        };
        await syncTeacherSlotToCourseSlot(updatedSlot, oldValues);

        // Mark request as approved
        await supabase
          .from("schedule_change_requests")
          .update({
            status: "approved",
            approved_by: req.user.id,
            approved_at: new Date().toISOString(),
          })
          .eq("id", requestId);

        // Get course name for notification
        let courseName = "the course";
        if (request.course_id) {
          const { data: courseData } = await supabase
            .from("courses")
            .select("name")
            .eq("id", request.course_id)
            .maybeSingle();
          if (courseData) {
            courseName = courseData.name;
          }
        }

        // Notify teacher of approval
        await supabase
          .from("notifications")
          .insert({
            recipient_id: request.teacher_id,
            sender_id: req.user.id,
            title: "Schedule Change Approved",
            message: `Your schedule change request has been approved. Your slot has been updated from ${request.current_day_of_week} ${request.current_start_time}-${request.current_end_time} to ${updatedSlot.day_of_week} ${updatedSlot.start_time}-${updatedSlot.end_time}.`,
            channels: ["in_app"],
            audience_scope: "custom",
            course_id: request.course_id,
          });

        // Notify all students enrolled in this course about the schedule change
        if (request.course_id) {
          const { data: enrolledStudents, error: enrollError } = await supabase
            .from("course_students")
            .select("student_id")
            .eq("course_id", request.course_id);

          if (!enrollError && enrolledStudents && enrolledStudents.length > 0) {
            const studentIds = enrolledStudents.map(e => e.student_id).filter(Boolean);
            
            // Build the schedule change message
            const oldSchedule = `${request.current_day_of_week} ${request.current_start_time}-${request.current_end_time}`;
            const newSchedule = `${updatedSlot.day_of_week} ${updatedSlot.start_time}-${updatedSlot.end_time}`;
            
            const studentNotifications = studentIds.map(studentId => ({
              recipient_id: studentId,
              sender_id: req.user.id,
              title: "Class Schedule Changed",
              message: `Your class "${courseName}" schedule has been rescheduled from ${oldSchedule} to ${newSchedule}. Please update your calendar accordingly.`,
              channels: ["in_app"],
              audience_scope: "course",
              course_id: request.course_id,
            }));

            const { error: studentNotifyError } = await supabase
              .from("notifications")
              .insert(studentNotifications);

            if (studentNotifyError) {
              console.error("[Approve Schedule Change] Error notifying students:", studentNotifyError);
            } else {
              console.log(`[Approve Schedule Change] Notified ${studentIds.length} student(s) about schedule change`);
            }
          }
        }

        const io = req.app.get("io");
        if (io) {
          io.emit("schedule-updated", {
            teacherId: request.teacher_id,
            slotId: request.slot_id,
            courseId: request.course_id,
          });
          io.emit("teacher-notifications-refresh", {
            teacherId: request.teacher_id,
          });
          io.emit("admin-notifications-refresh", {
            type: "schedule_change_approved",
          });
          // Emit event to refresh student timetables and notifications
          if (request.course_id) {
            io.emit("student-timetable-refresh", {
              courseId: request.course_id,
            });
            io.emit("student-notifications-refresh", {
              courseId: request.course_id,
            });
          }
        }

        res.json({
          message: "Schedule change approved and slot updated successfully",
          slot: updatedSlot,
        });
      } else {
        // No changes to make, just mark as approved
        await supabase
          .from("schedule_change_requests")
          .update({
            status: "approved",
            approved_by: req.user.id,
            approved_at: new Date().toISOString(),
          })
          .eq("id", requestId);

        // Notify teacher even if no changes were made
        await supabase
          .from("notifications")
          .insert({
            recipient_id: request.teacher_id,
            sender_id: req.user.id,
            title: "Schedule Change Approved",
            message: `Your schedule change request has been approved. No changes were needed.`,
            channels: ["in_app"],
            audience_scope: "custom",
            course_id: request.course_id,
          });

        const io = req.app.get("io");
        if (io) {
          io.emit("teacher-notifications-refresh", {
            teacherId: request.teacher_id,
          });
        }

        res.json({
          message: "Schedule change request approved",
        });
      }
    } catch (error) {
      console.error("Approve schedule change error:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  }
);

// POST /admin/schedule-change/:requestId/decline - Decline a schedule change request
router.post(
  "/schedule-change/:requestId/decline",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { requestId } = req.params;
      const { declineReason } = req.body;

      // Fetch the schedule change request
      const { data: request, error: requestError } = await supabase
        .from("schedule_change_requests")
        .select("*")
        .eq("id", requestId)
        .eq("status", "pending")
        .maybeSingle();

      if (requestError) {
        throw requestError;
      }

      if (!request) {
        return res.status(404).json({ message: "Schedule change request not found or already processed" });
      }

      // Mark request as declined
      await supabase
        .from("schedule_change_requests")
        .update({
          status: "declined",
          declined_by: req.user.id,
          declined_at: new Date().toISOString(),
          declined_reason: declineReason || null,
        })
        .eq("id", requestId);

      // Notify teacher of decline
      await supabase
        .from("notifications")
        .insert({
          recipient_id: request.teacher_id,
          sender_id: req.user.id,
          title: "Schedule Change Declined",
          message: `Your schedule change request has been declined.${declineReason ? ` Reason: ${declineReason}` : ''}`,
          channels: ["in_app"],
          audience_scope: "custom",
          course_id: request.course_id,
        });

      const io = req.app.get("io");
      if (io) {
        io.emit("teacher-notifications-refresh", {
          teacherId: request.teacher_id,
        });
        io.emit("admin-notifications-refresh", {
          type: "schedule_change_declined",
        });
      }

      res.json({
        message: "Schedule change request declined",
      });
    } catch (error) {
      console.error("Decline schedule change error:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  }
);

// GET /admin/schedule-change-requests - Get all pending schedule change requests
router.get(
  "/schedule-change-requests",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      console.log(`[Get Schedule Requests] Fetching pending requests for admin:`, {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        name: req.user.name
      });

      // Fetch all pending schedule change requests (visible to all admins)
      const { data: requests, error: requestsError } = await supabase
        .from("schedule_change_requests")
        .select(`
          id,
          slot_id,
          teacher_id,
          course_id,
          current_day_of_week,
          current_start_time,
          current_end_time,
          requested_day_of_week,
          requested_start_time,
          requested_end_time,
          reason,
          status,
          created_at
        `)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (requestsError) {
        console.error("[Get Schedule Requests] Error fetching requests:", requestsError);
        throw requestsError;
      }

      console.log(`[Get Schedule Requests] Found ${requests?.length || 0} pending requests`);

      if (!requests || requests.length === 0) {
        return res.json({ requests: [] });
      }

      // Fetch related data (teachers and courses)
      const teacherIds = [...new Set(requests.map(r => r.teacher_id).filter(Boolean))];
      const courseIds = [...new Set(requests.map(r => r.course_id).filter(Boolean))];

      const teacherMap = new Map();
      const courseMap = new Map();

      if (teacherIds.length > 0) {
        const { data: teachers, error: teachersError } = await supabase
          .from("users")
          .select("id, name, email, role")
          .in("id", teacherIds);
        
        if (!teachersError && teachers) {
          teachers.forEach(t => teacherMap.set(t.id, t));
        }
      }

      if (courseIds.length > 0) {
        const { data: courses, error: coursesError } = await supabase
          .from("courses")
          .select("id, name")
          .in("id", courseIds);
        
        if (!coursesError && courses) {
          courses.forEach(c => courseMap.set(c.id, c));
        }
      }

      // Map requests to the expected format
      const mappedRequests = requests.map((request) => {
        const teacher = teacherMap.get(request.teacher_id);
        const course = request.course_id ? courseMap.get(request.course_id) : null;

        return {
          id: request.id,
          notificationId: request.id, // Keep for backward compatibility
          slotId: request.slot_id,
          teacher: teacher ? {
            id: teacher.id,
            name: teacher.name,
            email: teacher.email,
          } : null,
          course: course ? {
            id: course.id,
            name: course.name,
          } : null,
          currentSlot: {
            dayOfWeek: request.current_day_of_week,
            startTime: request.current_start_time,
            endTime: request.current_end_time,
          },
          requestedSlot: {
            dayOfWeek: request.requested_day_of_week || request.current_day_of_week,
            startTime: request.requested_start_time || request.current_start_time,
            endTime: request.requested_end_time || request.current_end_time,
          },
          reason: request.reason,
          status: request.status,
          createdAt: request.created_at,
        };
      });

      console.log(`[Get Schedule Requests] Returning ${mappedRequests.length} requests`);
      res.json({ requests: mappedRequests });
    } catch (error) {
      console.error("Get schedule change requests error:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  }
);

// GET /admin/attendance/:courseId - Get attendance percentage for all students in a course
router.get(
  "/attendance/:courseId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { courseId } = req.params;

      // Verify course exists
      const { data: course, error: courseError } = await supabase
        .from("courses")
        .select("id, name")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) {
        throw courseError;
      }

      if (!course) {
        return res.status(404).json({ message: "Course not found" });
      }

      // Get all enrolled students for this course
      const { data: enrollments, error: enrollmentsError } = await supabase
        .from("course_students")
        .select("student_id")
        .eq("course_id", courseId);

      if (enrollmentsError) {
        throw enrollmentsError;
      }

      const studentIds = (enrollments || []).map((e) => e.student_id).filter(Boolean);

      if (studentIds.length === 0) {
        return res.json({
          courseId: course.id,
          courseName: course.name,
          students: [],
        });
      }

      // Get student details
      const { data: students, error: studentsError } = await supabase
        .from("users")
        .select("id, name, email, student_id")
        .in("id", studentIds)
        .eq("role", "student");

      if (studentsError) {
        throw studentsError;
      }

      // Get all attendance sessions for this course
      const { data: attendanceSessions, error: sessionsError } = await supabase
        .from("attendance")
        .select("id, session_date")
        .eq("course_id", courseId);

      if (sessionsError) {
        throw sessionsError;
      }

      const attendanceIds = (attendanceSessions || []).map((a) => a.id);

      // Get attendance records for all students
      const { data: attendanceRecords, error: recordsError } = await supabase
        .from("attendance_records")
        .select("attendance_id, student_id, status")
        .in("attendance_id", attendanceIds.length > 0 ? attendanceIds : ["00000000-0000-0000-0000-000000000000"]); // Use dummy ID if no sessions

      if (recordsError && recordsError.code !== "42P01") {
        throw recordsError;
      }

      // Calculate attendance for each student
      const studentAttendance = (students || []).map((student) => {
        const studentRecords = (attendanceRecords || []).filter(
          (r) => r.student_id === student.id
        );

        const presentCount = studentRecords.filter(
          (r) => r.status?.toLowerCase() === "present"
        ).length;
        const absentCount = studentRecords.filter(
          (r) => r.status?.toLowerCase() === "absent"
        ).length;
        const lateCount = studentRecords.filter(
          (r) => r.status?.toLowerCase() === "late"
        ).length;
        const excusedCount = studentRecords.filter(
          (r) => r.status?.toLowerCase() === "excused"
        ).length;
        const totalCount = studentRecords.length;

        const attendancePercentage =
          totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;

        return {
          studentId: student.id,
          name: student.name,
          email: student.email,
          studentIdNumber: student.student_id,
          present: presentCount,
          absent: absentCount,
          late: lateCount,
          excused: excusedCount,
          total: totalCount,
          percentage: attendancePercentage,
        };
      });

      // Sort by percentage (descending) then by name
      studentAttendance.sort((a, b) => {
        if (b.percentage !== a.percentage) {
          return b.percentage - a.percentage;
        }
        return a.name.localeCompare(b.name);
      });

      res.json({
        courseId: course.id,
        courseName: course.name,
        totalSessions: attendanceSessions?.length || 0,
        students: studentAttendance,
      });
    } catch (error) {
      console.error("Get course attendance error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// POST /admin/course-outline - Create or update course outline
router.post(
  "/course-outline",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { courseId, content } = req.body;

      if (!courseId || !content) {
        return res.status(400).json({ message: "Course ID and content are required" });
      }

      // Check if course exists
      const { data: course, error: courseError } = await supabase
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) throw courseError;
      if (!course) {
        return res.status(404).json({ message: "Course not found" });
      }

      // Upsert course outline (one per course)
      const { data: outline, error } = await supabase
        .from("course_outlines")
        .upsert(
          {
            course_id: courseId,
            content: content.trim(),
            created_by: req.user.id,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "course_id",
            ignoreDuplicates: false,
          }
        )
        .select(
          `
          id,
          course_id,
          content,
          created_by,
          created_at,
          updated_at,
          creator:created_by (
            id,
            name,
            email
          )
        `
        )
        .maybeSingle();

      if (error) throw error;

      res.json({
        id: outline.id,
        courseId: outline.course_id,
        content: outline.content,
        createdBy: outline.creator
          ? {
              id: outline.creator.id,
              name: outline.creator.name,
              email: outline.creator.email,
            }
          : null,
        createdAt: outline.created_at,
        updatedAt: outline.updated_at,
      });
    } catch (error) {
      console.error("Create/update course outline error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// PUT /admin/course-outline/:courseId - Update course outline
router.put(
  "/course-outline/:courseId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { courseId } = req.params;
      const { content } = req.body;

      if (!content) {
        return res.status(400).json({ message: "Content is required" });
      }

      // Check if outline exists
      const { data: existing, error: checkError } = await supabase
        .from("course_outlines")
        .select("id")
        .eq("course_id", courseId)
        .maybeSingle();

      if (checkError) throw checkError;
      if (!existing) {
        return res.status(404).json({ message: "Course outline not found" });
      }

      // Update outline
      const { data: outline, error } = await supabase
        .from("course_outlines")
        .update({
          content: content.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq("course_id", courseId)
        .select(
          `
          id,
          course_id,
          content,
          created_by,
          created_at,
          updated_at,
          creator:created_by (
            id,
            name,
            email
          )
        `
        )
        .maybeSingle();

      if (error) throw error;

      res.json({
        id: outline.id,
        courseId: outline.course_id,
        content: outline.content,
        createdBy: outline.creator
          ? {
              id: outline.creator.id,
              name: outline.creator.name,
              email: outline.creator.email,
            }
          : null,
        createdAt: outline.created_at,
        updatedAt: outline.updated_at,
      });
    } catch (error) {
      console.error("Update course outline error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /admin/course-outline/:courseId - Get course outline
router.get(
  "/course-outline/:courseId",
  protect,
  requireAdminRole,
  async (req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { courseId } = req.params;

      const { data: outline, error } = await supabase
        .from("course_outlines")
        .select(
          `
          id,
          course_id,
          content,
          created_by,
          created_at,
          updated_at,
          creator:created_by (
            id,
            name,
            email
          )
        `
        )
        .eq("course_id", courseId)
        .maybeSingle();

      if (error) throw error;

      if (!outline) {
        return res.json(null);
      }

      res.json({
        id: outline.id,
        courseId: outline.course_id,
        content: outline.content,
        createdBy: outline.creator
          ? {
              id: outline.creator.id,
              name: outline.creator.name,
              email: outline.creator.email,
            }
          : null,
        createdAt: outline.created_at,
        updatedAt: outline.updated_at,
      });
    } catch (error) {
      console.error("Fetch course outline error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// GET /admin/course-outlines - Get all course outlines
router.get(
  "/course-outlines",
  protect,
  requireAdminRole,
  async (_req, res) => {
    if (!guardSupabase(res)) {
      return;
    }

    try {
      const { data: outlines, error } = await supabase
        .from("course_outlines")
        .select(
          `
          id,
          course_id,
          content,
          created_by,
          created_at,
          updated_at,
          creator:created_by (
            id,
            name,
            email
          ),
          course:courses!course_outlines_course_id_fkey (
            id,
            name,
            description
          )
        `
        )
        .order("updated_at", { ascending: false });

      if (error) throw error;

      res.json(
        (outlines ?? []).map((outline) => ({
          id: outline.id,
          courseId: outline.course_id,
          courseName: outline.course?.name || "Unknown Course",
          courseDescription: outline.course?.description || null,
          content: outline.content,
          createdBy: outline.creator
            ? {
                id: outline.creator.id,
                name: outline.creator.name,
                email: outline.creator.email,
              }
            : null,
          createdAt: outline.created_at,
          updatedAt: outline.updated_at,
        }))
      );
    } catch (error) {
      console.error("Fetch all course outlines error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;

