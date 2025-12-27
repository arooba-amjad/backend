import express from "express";
import { protect, authorizeRoles } from "../middleware/authMiddleware.js";
import { supabase } from "../config/supabaseClient.js";

const router = express.Router();

router.use(protect, authorizeRoles("student"));

const ensureStudentAccess = async (user, courseId) => {
  console.log(`[ensureStudentAccess] Checking access for user ${user.id} to course ${courseId}`);
  
  const { data: enrollment, error } = await supabase
    .from("course_students")
    .select("course_id")
    .eq("course_id", courseId)
    .eq("student_id", user.id)
    .maybeSingle();

  if (error) {
    console.error(`[ensureStudentAccess] Database error:`, error);
    console.error(`[ensureStudentAccess] Error code:`, error.code);
    console.error(`[ensureStudentAccess] Error message:`, error.message);
    return { error: { status: 500, message: `Server error: ${error.message || 'Database query failed'}` } };
  }

  console.log(`[ensureStudentAccess] Enrollment check result:`, enrollment ? 'Found' : 'Not found');

  if (!enrollment && user.studentId) {
    console.log(`[ensureStudentAccess] Trying alternative lookup with studentId: ${user.studentId}`);
    const { data: stringEnrollment } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("course_id", courseId)
      .eq("student_id", user.studentId.toUpperCase())
      .maybeSingle();
    
    if (stringEnrollment) {
      console.log(`[ensureStudentAccess] Found enrollment via studentId`);
      return { access: true };
    }
  }

  if (!enrollment) {
    console.log(`[ensureStudentAccess] Access denied - student not enrolled`);
    return { error: { status: 403, message: "Access denied: not enrolled in this course" } };
  }

  console.log(`[ensureStudentAccess] Access granted`);
  return { access: true };
};

// GET /student/profile
router.get("/profile", async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, email, status, metadata")
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) throw error;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      metadata: user.metadata || {},
    });
  } catch (error) {
    console.error("Get student profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /student/profile
router.put("/profile", async (req, res) => {
  try {
    const { name, email, metadata } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (metadata) updateData.metadata = metadata;

    const { error } = await supabase
      .from("users")
      .update(updateData)
      .eq("id", req.user.id);

    if (error) throw error;

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update student profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/courses
router.get("/courses", async (req, res) => {
  try {
    console.log(`\n[STUDENT COURSES] ========================================`);
    console.log(`[STUDENT COURSES] Request received`);
    console.log(`[STUDENT COURSES] User ID: ${req.user.id}`);
    console.log(`[STUDENT COURSES] User Email: ${req.user.email}`);
    console.log(`[STUDENT COURSES] User Status (from req.user): ${req.user.status}`);
    
    // Check if student status is explicitly set to inactive (not null/undefined)
    // Only block if status is explicitly set to something other than 'active'
    if (req.user.status && req.user.status.trim() && req.user.status.toLowerCase() !== 'active') {
      console.log(`[STATUS CHECK] Student status is "${req.user.status}", not active. Returning empty array.`);
      return res.json([]);
    }

    // Verify status from database
    const { data: userData, error: userStatusError } = await supabase
      .from("users")
      .select("status, name, email, course_id")
      .eq("id", req.user.id)
      .maybeSingle();
    
    if (userStatusError) {
      console.error(`[STATUS CHECK] Error fetching user status:`, userStatusError);
    } else {
      console.log(`[STATUS CHECK] Database status: ${userData?.status || 'null/undefined'}`);
    }
    
    // Only block if status is explicitly set to something other than 'active' (allow null/undefined)
    if (userData && userData.status && userData.status.trim() && userData.status.toLowerCase() !== 'active') {
      console.log(`[STATUS CHECK] Database shows status "${userData.status}", not active. Returning empty array.`);
      return res.json([]);
    }
    
    console.log(`[STATUS CHECK] Status check passed (active or null/undefined)`);

    // Get enrolled courses - query by user.id (UUID)
    console.log(`[STUDENT COURSES] Fetching courses for student ID: ${req.user.id}, email: ${req.user.email}`);
    
    // First, fetch the user's current data from database to get course_id
    const { data: currentUser, error: userFetchError } = await supabase
      .from("users")
      .select("id, course_id, email, name, status")
      .eq("id", req.user.id)
      .maybeSingle();
    
    if (userFetchError) {
      console.error("[STUDENT COURSES] Error fetching user data:", userFetchError);
    }
    
    const userCourseId = currentUser?.course_id || req.user.course_id;
    console.log(`[STUDENT COURSES] User course_id from DB: ${userCourseId}`);
    
    // First, try to get enrollments with student_id matching user.id
    let { data: enrollments, error: enrollmentError } = await supabase
      .from("course_students")
      .select(
        `
        course_id,
        student_id,
        student_email,
        course:course_id (
          id,
          name,
          description,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          )
        )
      `
      )
      .eq("student_id", req.user.id)
      .not("student_id", "is", null); // Only get enrollments where student_id is not null

    console.log(`[STUDENT COURSES] Query by user.id - found ${enrollments?.length || 0} enrollments`);
    
    if (enrollmentError) {
      console.error("[STUDENT COURSES] Enrollment query error:", enrollmentError);
    }

    // If no enrollments found, try querying by email (in case student_id wasn't set properly)
    if ((!enrollments || enrollments.length === 0) && req.user.email) {
      console.log(`[STUDENT COURSES] Trying to find enrollments by email: ${req.user.email}`);
      const { data: emailEnrollments, error: emailError } = await supabase
        .from("course_students")
        .select(
          `
          course_id,
          student_id,
          student_email,
          course:course_id (
            id,
            name,
            description,
            teacher_id,
            teacher:teacher_id (
              id,
              name,
              email,
              metadata
            )
          )
        `
        )
        .eq("student_email", req.user.email.toLowerCase());
      
      if (emailEnrollments && emailEnrollments.length > 0) {
        console.log(`[STUDENT COURSES] Found ${emailEnrollments.length} enrollments by email`);
        // Filter to only those with null student_id or update existing ones
        const enrollmentsToLink = emailEnrollments.filter(e => !e.student_id || e.student_id !== req.user.id);
        
        if (enrollmentsToLink.length > 0) {
          // Update enrollments by course_id and student_email since id column might not exist
          for (const enrollment of enrollmentsToLink) {
          const { error: updateError } = await supabase
            .from("course_students")
            .update({ student_id: req.user.id })
              .eq("course_id", enrollment.course_id)
              .eq("student_email", req.user.email.toLowerCase());
            
            if (updateError) {
              console.error(`[STUDENT COURSES] Error updating enrollment for course ${enrollment.course_id}:`, updateError);
            }
          }
          
          if (!updateError) {
            enrollments = emailEnrollments.map(e => ({ ...e, student_id: req.user.id }));
            console.log(`[STUDENT COURSES] Updated ${enrollmentsToLink.length} enrollments to link to user.id`);
          } else {
            console.error(`[STUDENT COURSES] Error updating enrollments:`, updateError);
          }
        } else {
          // Use the enrollments as-is if they're already linked
          enrollments = emailEnrollments;
          console.log(`[STUDENT COURSES] Using existing linked enrollments`);
        }
      }
    }
    
    // Also check if user has course_id set but no enrollment record (legacy data)
    if ((!enrollments || enrollments.length === 0) && userCourseId) {
      console.log(`[STUDENT COURSES] User has course_id (${userCourseId}) but no enrollment record. Creating enrollment...`);
      const { data: courseData } = await supabase
        .from("courses")
        .select("id, name")
        .eq("id", userCourseId)
        .maybeSingle();
      
      if (courseData) {
        const { error: createError } = await supabase
          .from("course_students")
          .insert({
            course_id: userCourseId,
            student_id: req.user.id,
            student_name: currentUser?.name || req.user.name,
            student_email: currentUser?.email || req.user.email,
            course_name: courseData.name,
          });
        
        if (!createError) {
          console.log(`[STUDENT COURSES] Created enrollment record from user.course_id`);
          // Re-query to get the new enrollment
          const { data: newEnrollments } = await supabase
            .from("course_students")
            .select(
              `
              course_id,
              student_id,
              student_email,
              course:course_id (
                id,
                name,
                description,
                teacher_id,
                teacher:teacher_id (
                  id,
                  name,
                  email,
                  metadata
                )
              )
            `
            )
            .eq("student_id", req.user.id);
          
          if (newEnrollments) {
            enrollments = newEnrollments;
          }
        } else {
          console.error(`[STUDENT COURSES] Error creating enrollment:`, createError);
        }
      }
    }
    
    // Final fallback: If still no enrollments but user has course_id, query course directly
    if ((!enrollments || enrollments.length === 0) && userCourseId) {
      console.log(`[STUDENT COURSES] Final fallback: Querying course directly by course_id: ${userCourseId}`);
      const { data: directCourse, error: directError } = await supabase
        .from("courses")
        .select(
          `
          id,
          name,
          description,
          credits,
          teacher_id,
          teacher:teacher_id (
            id,
            name,
            email,
            metadata
          )
        `
        )
        .eq("id", userCourseId)
        .maybeSingle();
      
      if (directCourse && !directError) {
        console.log(`[STUDENT COURSES] Found course directly: ${directCourse.name}`);
        // Create a mock enrollment structure for response
        enrollments = [{
          course_id: directCourse.id,
          student_id: req.user.id,
          student_email: req.user.email,
          course: directCourse
        }];
      }
    }

    // Filter out any enrollments without courses and map to response format
    const courses = (enrollments || [])
      .filter((row) => {
        if (!row.course || !row.course.id) {
          console.log(`[STUDENT COURSES] Skipping enrollment - missing course data (course_id: ${row.course_id})`);
          return false;
        }
        return true;
      })
      .map((row) => ({
        id: row.course.id,
        name: row.course.name,
        description: row.course.description || "",
        credits: 0, // Credits column doesn't exist in courses table
        teacher: row.course.teacher
          ? {
              id: row.course.teacher.id,
              name: row.course.teacher.name,
              email: row.course.teacher.email,
              metadata: row.course.teacher.metadata || {},
            }
          : null,
      }));

    console.log(`[STUDENT COURSES] Returning ${courses.length} courses`);
    
    // Diagnostic logging
    if (courses.length === 0) {
      console.log(`[STUDENT COURSES] ⚠️ No courses found for student`);
      console.log(`[STUDENT COURSES] Diagnostic info:`);
      console.log(`  - Enrollments found: ${enrollments?.length || 0}`);
      console.log(`  - User course_id: ${userCourseId || 'none'}`);
      console.log(`  - User status: ${userData?.status || req.user.status || 'null/undefined'}`);
      
      if (enrollments && enrollments.length > 0) {
      console.log(`[STUDENT COURSES] WARNING: Found ${enrollments.length} enrollments but 0 courses after filtering`);
      console.log(`[STUDENT COURSES] Enrollment details:`, enrollments.map(e => ({
        course_id: e.course_id,
          student_id: e.student_id,
        has_course: !!e.course,
          course_id_in_course: e.course?.id,
          course_name: e.course?.name
      })));
      } else {
        console.log(`[STUDENT COURSES] No enrollments found in course_students table`);
        console.log(`[STUDENT COURSES] Student may need to be enrolled in courses by an administrator`);
    }
    } else {
      console.log(`[STUDENT COURSES] ✅ Successfully returning ${courses.length} course(s)`);
    }
    
    res.json(courses);
  } catch (error) {
    console.error("Get student courses error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/courses/:courseId
router.get("/courses/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    
    if (!courseId) {
      return res.status(400).json({ message: "Course ID is required" });
    }
    
    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    
    console.log(`[Course Details] Request for course ${courseId} by user ${req.user.id}`);
    
    const access = await ensureStudentAccess(req.user, courseId);
    if (access.error) {
      console.log(`[Course Details] Access denied: ${access.error.message}`);
      return res.status(access.error.status).json({ message: access.error.message });
    }
    
    console.log(`[Course Details] Access granted, fetching course data...`);

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select(
        `
        id,
        name,
        description,
        credits,
        teacher_id,
        teacher:teacher_id (
          id,
          name,
          email,
          metadata
        )
      `
      )
      .eq("id", courseId)
      .maybeSingle();

    if (courseError) throw courseError;
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    // Get assignments
    let assignments = [];
    let submissions = [];
    try {
      const { data: assignmentsData, error: assignmentsError } = await supabase
        .from("assignments")
        .select("id, title, description, due_date, course_id, total_points")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (assignmentsError) {
        console.error("[Course Details] Error fetching assignments:", assignmentsError);
      } else {
        assignments = assignmentsData || [];
      }

      // Get submissions
      const assignmentIds = assignments.map((a) => a.id);
      if (assignmentIds.length > 0) {
        const { data: submissionsData, error: submissionsError } = await supabase
          .from("submissions")
          .select("assignment_id, status, marks, feedback, files, link, created_at, updated_at")
          .eq("student_id", req.user.id)
          .in("assignment_id", assignmentIds);

        if (submissionsError) {
          console.error("[Course Details] Error fetching submissions:", submissionsError);
        } else {
          submissions = submissionsData || [];
        }
      }
    } catch (error) {
      console.error("[Course Details] Error in assignments/submissions fetch:", error);
      // Continue with empty arrays
    }

    const submissionMap = new Map();
    submissions.forEach((sub) => {
      submissionMap.set(sub.assignment_id, {
        id: sub.assignment_id,
        status: sub.status,
        score: sub.marks ?? null, // Use marks from database
        feedback: sub.feedback ?? null, // Use feedback from database
        files: sub.files || [],
        link: sub.link,
        submittedAt: sub.created_at,
        updatedAt: sub.updated_at,
      });
    });

    // Get course outline
    let outline = null;
    try {
      const { data: outlineData, error: outlineError } = await supabase
        .from("course_outlines")
        .select("id, content, created_at, updated_at")
        .eq("course_id", courseId)
        .maybeSingle();

      // Log outline fetch result (non-blocking if table doesn't exist)
      if (outlineError) {
        if (outlineError.code === '42P01') {
          // Table doesn't exist - this is okay, just log it
          console.log(`[Course Details] course_outlines table not found. Run create_course_outlines_table.sql in Supabase.`);
        } else {
          console.error("[Course Details] Error fetching course outline:", outlineError);
          console.error("[Course Details] Outline error details:", {
            code: outlineError.code,
            message: outlineError.message,
            details: outlineError.details,
            hint: outlineError.hint,
          });
        }
      } else if (outlineData) {
        outline = outlineData;
        console.log(`[Course Details] ✅ Found outline for course ${courseId}:`, {
          id: outline.id,
          contentLength: outline.content?.length || 0,
          contentType: typeof outline.content,
        });
      } else {
        console.log(`[Course Details] ℹ️ No outline found for course ${courseId} (this is normal if not created yet)`);
      }
    } catch (error) {
      console.error("[Course Details] Exception while fetching course outline:", error);
      // Continue without outline
    }

    // Get resources
    let resources = [];
    try {
      const { data: resourcesData, error: resourcesError } = await supabase
        .from("resources")
        .select("id, title, type, file_url, description, created_at")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (resourcesError) {
        console.error("[Course Details] Error fetching resources:", resourcesError);
      } else {
        resources = resourcesData || [];
      }
    } catch (error) {
      console.error("[Course Details] Error in resources fetch:", error);
    }

    // Get timetable
    let timetable = [];
    try {
      const { data: timetableData, error: timetableError } = await supabase
        .from("course_schedule_slots")
        .select(
          `
          id,
          day_of_week,
          start_time,
          end_time,
          location,
          notes,
          teacher:teacher_id (
            name
          )
        `
        )
        .eq("course_id", courseId);

      if (timetableError) {
        console.error("[Course Details] Error fetching timetable:", timetableError);
      } else {
        timetable = timetableData || [];
      }
    } catch (error) {
      console.error("[Course Details] Error in timetable fetch:", error);
    }

    // Get progress
    let progress = null;
    try {
      const { data: progressData, error: progressError } = await supabase
        .from("course_progress")
        .select("progress, state, grade, updated_at, remarks")
        .eq("course_id", courseId)
        .eq("student_id", req.user.id)
        .maybeSingle();

      if (progressError) {
        console.error("[Course Details] Error fetching progress:", progressError);
      } else {
        progress = progressData;
      }
    } catch (error) {
      console.error("[Course Details] Error in progress fetch:", error);
    }

    // Build response safely
    try {
      const response = {
        course: {
          id: course.id,
          name: course.name || "Unknown Course",
          description: course.description || "",
          credits: course.credits || 0,
          teacher: course.teacher && Array.isArray(course.teacher) && course.teacher.length > 0
            ? {
                id: course.teacher[0].id,
                name: course.teacher[0].name,
                email: course.teacher[0].email,
                metadata: course.teacher[0].metadata || {},
              }
            : course.teacher && !Array.isArray(course.teacher)
            ? {
                id: course.teacher.id,
                name: course.teacher.name,
                email: course.teacher.email,
                metadata: course.teacher.metadata || {},
              }
            : null,
        },
        assignments: (assignments || []).map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          dueDate: a.due_date,
          courseId: a.course_id,
          courseName: course.name,
          totalPoints: a.total_points ?? 100,
          submission: submissionMap.get(a.id) || null,
        })),
        resources: (resources || []).map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          fileUrl: r.file_url,
          description: r.description,
          createdAt: r.created_at,
        })),
        timetable: (timetable || []).map((t) => ({
          id: t.id,
          dayOfWeek: t.day_of_week,
          startTime: t.start_time,
          endTime: t.end_time,
          location: t.location,
          notes: t.notes,
          teacherName: t.teacher?.name || (Array.isArray(t.teacher) && t.teacher.length > 0 ? t.teacher[0].name : "Unknown"),
        })),
        progress: progress
          ? {
              courseId: course.id,
              courseName: course.name,
              progress: progress.progress || 0,
              state: progress.state || "not_started",
              grade: progress.grade,
              updatedAt: progress.updated_at,
              remarks: progress.remarks,
            }
          : null,
        outline: outline
          ? {
              id: outline.id,
              content: typeof outline.content === 'string' ? outline.content : JSON.stringify(outline.content),
              createdAt: outline.created_at,
              updatedAt: outline.updated_at,
            }
          : null,
      };

      console.log(`[Course Details] ✅ Successfully returning course details for ${courseId}`);
      res.json(response);
    } catch (responseError) {
      console.error("[Course Details] Error building response:", responseError);
      throw responseError; // Re-throw to be caught by outer catch
    }
  } catch (error) {
    console.error("Get course details error:", error);
    console.error("Error stack:", error.stack);
    console.error("Error details:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    res.status(500).json({ 
      message: "Server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /student/course-outline/:courseId - Get course outline by course ID
router.get("/course-outline/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    
    if (!courseId) {
      return res.status(400).json({ message: "Course ID is required" });
    }
    
    console.log(`[Course Outline] Fetching outline for course ${courseId}`);
    
    // Get course outline directly - no enrollment check needed for viewing outline
    let outline = null;
    try {
      const { data: outlineData, error: outlineError } = await supabase
        .from("course_outlines")
        .select("id, content, created_at, updated_at")
        .eq("course_id", courseId)
        .maybeSingle();

      if (outlineError) {
        if (outlineError.code === '42P01') {
          // Table doesn't exist
          console.log(`[Course Outline] course_outlines table not found. Run create_course_outlines_table.sql in Supabase.`);
          return res.status(404).json({ message: "Course outline table not found" });
        } else {
          console.error("[Course Outline] Error fetching course outline:", outlineError);
          return res.status(500).json({ 
            message: "Error fetching course outline",
            error: process.env.NODE_ENV === 'development' ? outlineError.message : undefined
          });
        }
      } else if (outlineData) {
        outline = outlineData;
        console.log(`[Course Outline] ✅ Found outline for course ${courseId}`);
      } else {
        console.log(`[Course Outline] ℹ️ No outline found for course ${courseId}`);
        return res.status(404).json({ message: "Course outline not found" });
      }
    } catch (error) {
      console.error("[Course Outline] Exception while fetching course outline:", error);
      return res.status(500).json({ 
        message: "Error fetching course outline",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }

    // Return the outline
    res.json({
      id: outline.id,
      courseId: courseId,
      content: typeof outline.content === 'string' ? outline.content : JSON.stringify(outline.content),
      createdAt: outline.created_at,
      updatedAt: outline.updated_at,
    });
  } catch (error) {
    console.error("Get course outline error:", error);
    res.status(500).json({ 
      message: "Server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /student/courses/:courseId/stats
router.get("/courses/:courseId/stats", async (req, res) => {
  try {
    const { courseId } = req.params;
    const access = await ensureStudentAccess(req.user, courseId);
    if (access.error) {
      return res.status(access.error.status).json({ message: access.error.message });
    }

    // Get attendance percentage
    // First get attendance sessions for this course
    const { data: courseAttendanceSessions, error: sessionsError } = await supabase
      .from("attendance")
      .select("id")
      .eq("course_id", courseId);

    let attendanceRecords = [];
    if (!sessionsError && courseAttendanceSessions && courseAttendanceSessions.length > 0) {
      const attendanceIds = courseAttendanceSessions.map(a => a.id);
      const { data: records, error: recordsError } = await supabase
      .from("attendance_records")
      .select("status")
        .eq("student_id", req.user.id)
        .in("attendance_id", attendanceIds);
      
      if (!recordsError) {
        attendanceRecords = records || [];
      }
    }

    const presentCount = (attendanceRecords || []).filter((r) => r.status?.toLowerCase() === "present").length;
    const totalCount = (attendanceRecords || []).length;
    const attendancePercentage = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;

    // Get pending assignments
    const { data: assignments } = await supabase
      .from("assignments")
      .select("id, due_date")
      .eq("course_id", courseId);

    const { data: submissions } = await supabase
      .from("submissions")
      .select("assignment_id")
      .eq("student_id", req.user.id)
      .in("assignment_id", (assignments || []).map((a) => a.id));

    const submittedAssignmentIds = new Set((submissions || []).map((s) => s.assignment_id));
    const pendingAssignments = (assignments || []).filter(
      (a) => !submittedAssignmentIds.has(a.id) && new Date(a.due_date) > new Date()
    ).length;

    // Get next class time - find the next upcoming class in the week
    const today = new Date();
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const todayDayIndex = today.getDay();
    const todayName = dayNames[todayDayIndex];
    const currentTime = today.toTimeString().slice(0, 5); // HH:MM format

    // Get all schedule slots for this course
    const { data: allSlots, error: slotsError } = await supabase
      .from("course_schedule_slots")
      .select("day_of_week, start_time")
      .eq("course_id", courseId)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    let nextClassTime = null;

    if (allSlots && allSlots.length > 0) {
      // First, check if there's a class today that hasn't started yet
      const todaySlots = allSlots.filter(
        slot => slot.day_of_week.toLowerCase() === todayName && slot.start_time >= currentTime
      );

      if (todaySlots.length > 0) {
        // Found a class today that hasn't started
      nextClassTime = `${todayName} ${todaySlots[0].start_time}`;
      } else {
        // No class today or all classes passed, find the next class in the week
        // Create a list of days starting from tomorrow, wrapping around the week
        const daysToCheck = [];
        for (let i = 1; i <= 7; i++) {
          const dayIndex = (todayDayIndex + i) % 7;
          daysToCheck.push(dayNames[dayIndex]);
        }

        // Find the first upcoming class
        for (const dayName of daysToCheck) {
          const daySlots = allSlots.filter(
            slot => slot.day_of_week.toLowerCase() === dayName
          );
          if (daySlots.length > 0) {
            nextClassTime = `${dayName} ${daySlots[0].start_time}`;
            break;
          }
        }
      }
    }

    if (slotsError) {
      console.error("[STUDENT COURSES] Error fetching schedule slots:", slotsError);
    }

    res.json({
      courseId,
      attendancePercentage,
      pendingAssignments,
      nextClassTime,
    });
  } catch (error) {
    console.error("Get course stats error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/attendance
router.get("/attendance", async (req, res) => {
  try {
    console.log(`[STUDENT ATTENDANCE] Fetching attendance for student: ${req.user.id}`);
    
    // First, get all attendance records for this student
    const { data: records, error: recordsError } = await supabase
      .from("attendance_records")
      .select("attendance_id, student_id, status")
      .eq("student_id", req.user.id);

    if (recordsError) {
      console.error("[STUDENT ATTENDANCE] Error fetching attendance records:", recordsError);
      // If table doesn't exist or has issues, return empty array instead of 500
      if (recordsError.code === "42P01") {
        console.log("[STUDENT ATTENDANCE] attendance_records table not found, returning empty array");
        return res.json([]);
      }
      throw recordsError;
    }

    console.log(`[STUDENT ATTENDANCE] Found ${records?.length || 0} attendance record(s)`);

    if (!records || records.length === 0) {
      return res.json([]);
    }

    // Get unique attendance IDs
    const attendanceIds = [...new Set((records || []).map(r => r.attendance_id).filter(Boolean))];
    
    if (attendanceIds.length === 0) {
      console.log("[STUDENT ATTENDANCE] No attendance IDs found, returning empty array");
      return res.json([]);
    }

    // Fetch attendance sessions (without nested query)
    const { data: attendanceSessions, error: sessionsError } = await supabase
      .from("attendance")
      .select("id, course_id, session_date")
      .in("id", attendanceIds);

    if (sessionsError) {
      console.error("[STUDENT ATTENDANCE] Error fetching attendance sessions:", sessionsError);
      // If attendance table doesn't exist, return records without course info
      if (sessionsError.code === "42P01") {
        console.log("[STUDENT ATTENDANCE] attendance table not found, returning records without course info");
    const mapped = (records || []).map((r) => ({
      attendanceId: r.attendance_id,
          courseId: "",
          courseName: "Unknown Course",
          date: "",
      status: r.status || "Absent",
          timestamp: null,
        }));
        return res.json(mapped);
      }
      throw sessionsError;
    }

    // Get unique course IDs
    const courseIds = [...new Set((attendanceSessions || []).map(s => s.course_id).filter(Boolean))];
    
    // Fetch course names separately
    const courseMap = new Map();
    if (courseIds.length > 0) {
      const { data: courses, error: coursesError } = await supabase
        .from("courses")
        .select("id, name")
        .in("id", courseIds);
      
      if (!coursesError && courses) {
        courses.forEach(course => {
          courseMap.set(course.id, course.name);
        });
      }
    }

    // Create a map of attendance_id -> attendance session
    const attendanceMap = new Map();
    (attendanceSessions || []).forEach(session => {
      attendanceMap.set(session.id, session);
    });

    // Map records with attendance session info
    const mapped = (records || []).map((r) => {
      const session = attendanceMap.get(r.attendance_id);
      const courseId = session?.course_id || "";
      const courseName = courseId ? (courseMap.get(courseId) || "Unknown Course") : "Unknown Course";
      return {
        attendanceId: r.attendance_id,
        courseId: courseId,
        courseName: courseName,
        date: session?.session_date || "",
        status: r.status || "Absent",
        timestamp: null,
      };
    });

    console.log(`[STUDENT ATTENDANCE] Returning ${mapped.length} attendance record(s)`);
    res.json(mapped);
  } catch (error) {
    console.error("[STUDENT ATTENDANCE] Get attendance records error:", error);
    console.error("[STUDENT ATTENDANCE] Error details:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// GET /student/attendance/today
router.get("/attendance/today", async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    console.log(`[STUDENT ATTENDANCE TODAY] Fetching today's attendance for student: ${req.user.id}, date: ${today}`);

    // First get attendance sessions for today
    const { data: todayAttendance, error: attendanceError } = await supabase
      .from("attendance")
      .select("id, course_id, session_date")
      .eq("session_date", today);

    if (attendanceError) {
      console.error("[STUDENT ATTENDANCE TODAY] Error fetching attendance sessions:", attendanceError);
      // If table doesn't exist, return empty array
      if (attendanceError.code === "42P01") {
        console.log("[STUDENT ATTENDANCE TODAY] attendance table not found, returning empty array");
        return res.json([]);
      }
      throw attendanceError;
    }

    console.log(`[STUDENT ATTENDANCE TODAY] Found ${todayAttendance?.length || 0} attendance session(s) for today`);

    const attendanceIds = (todayAttendance || []).map((a) => a.id).filter(Boolean);
    if (attendanceIds.length === 0) {
      console.log("[STUDENT ATTENDANCE TODAY] No attendance sessions for today, returning empty array");
      return res.json([]);
    }

    // Get records for today's attendance sessions (without nested query)
    const { data: records, error: recordsError } = await supabase
      .from("attendance_records")
      .select("attendance_id, student_id, status")
      .eq("student_id", req.user.id)
      .in("attendance_id", attendanceIds);

    if (recordsError) {
      console.error("[STUDENT ATTENDANCE TODAY] Error fetching attendance records:", recordsError);
      // If table doesn't exist, return empty array
      if (recordsError.code === "42P01") {
        console.log("[STUDENT ATTENDANCE TODAY] attendance_records table not found, returning empty array");
        return res.json([]);
      }
      throw recordsError;
    }

    // Get unique course IDs
    const courseIds = [...new Set((todayAttendance || []).map(s => s.course_id).filter(Boolean))];
    
    // Fetch course names separately
    const courseMap = new Map();
    if (courseIds.length > 0) {
      const { data: courses, error: coursesError } = await supabase
        .from("courses")
        .select("id, name")
        .in("id", courseIds);
      
      if (!coursesError && courses) {
        courses.forEach(course => {
          courseMap.set(course.id, course.name);
        });
      }
    }

    // Create a map of attendance_id -> attendance session
    const attendanceMap = new Map();
    (todayAttendance || []).forEach(session => {
      attendanceMap.set(session.id, session);
    });

    const mapped = (records || []).map((r) => {
      const session = attendanceMap.get(r.attendance_id);
      const courseId = session?.course_id || "";
      const courseName = courseId ? (courseMap.get(courseId) || "Unknown Course") : "Unknown Course";
      return {
      attendanceId: r.attendance_id,
        courseId: courseId,
        courseName: courseName,
        date: session?.session_date || today,
      status: r.status || "Absent",
        timestamp: null,
      };
    });

    console.log(`[STUDENT ATTENDANCE TODAY] Returning ${mapped.length} record(s) for today`);
    res.json(mapped);
  } catch (error) {
    console.error("[STUDENT ATTENDANCE TODAY] Get today attendance error:", error);
    console.error("[STUDENT ATTENDANCE TODAY] Error details:", {
      message: error.message,
      code: error.code,
      details: error.details
    });
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// GET /student/attendance-summary
router.get("/attendance-summary", async (req, res) => {
  try {
    console.log(`[STUDENT ATTENDANCE SUMMARY] Fetching summary for student: ${req.user.id}`);
    
    // First get attendance records (without nested query)
    const { data: records, error: recordsError } = await supabase
      .from("attendance_records")
      .select("attendance_id, status")
      .eq("student_id", req.user.id);

    if (recordsError) {
      console.error("[STUDENT ATTENDANCE SUMMARY] Error fetching records:", recordsError);
      // If table doesn't exist, return empty array
      if (recordsError.code === "42P01") {
        console.log("[STUDENT ATTENDANCE SUMMARY] attendance_records table not found, returning empty array");
        return res.json([]);
      }
      return res.json([]);
    }

    if (!records || records.length === 0) {
      console.log("[STUDENT ATTENDANCE SUMMARY] No records found, returning empty array");
      return res.json([]);
    }

    // Get unique attendance IDs
    const attendanceIds = [...new Set((records || []).map(r => r.attendance_id).filter(Boolean))];
    
    // Fetch attendance sessions to get session_date
    let attendanceMap = new Map();
    if (attendanceIds.length > 0) {
      const { data: attendanceSessions, error: sessionsError } = await supabase
        .from("attendance")
        .select("id, session_date")
        .in("id", attendanceIds);

      if (!sessionsError && attendanceSessions) {
        attendanceSessions.forEach(session => {
          attendanceMap.set(session.id, session);
        });
      }
    }

    // Group by month
    const summary = new Map();
    (records || []).forEach((r) => {
      // Get session date from map
      const session = attendanceMap.get(r.attendance_id);
      const date = session?.session_date;
      if (!date) return;

      try {
      const month = new Date(date).toLocaleString("default", { month: "long", year: "numeric" });
      if (!summary.has(month)) {
        summary.set(month, { month, present: 0, absent: 0, late: 0, excused: 0 });
      }

      const status = (r.status || "Absent").toLowerCase();
      const monthData = summary.get(month);
      if (status === "present") monthData.present++;
      else if (status === "absent") monthData.absent++;
      else if (status === "late") monthData.late++;
      else if (status === "excused") monthData.excused++;
      } catch (dateError) {
        console.error("[STUDENT ATTENDANCE SUMMARY] Error parsing date:", date, dateError);
      }
    });

    const result = Array.from(summary.values());
    console.log(`[STUDENT ATTENDANCE SUMMARY] Returning summary for ${result.length} month(s)`);
    res.json(result);
  } catch (error) {
    console.error("Get attendance summary error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/attendance/:courseId
router.get("/attendance/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    const access = await ensureStudentAccess(req.user, courseId);
    if (access.error) {
      return res.status(access.error.status).json({ message: access.error.message });
    }

    // First get attendance sessions for this course
    const { data: courseAttendance, error: attendanceError } = await supabase
      .from("attendance")
      .select("id")
      .eq("course_id", courseId);

    if (attendanceError) throw attendanceError;

    const attendanceIds = (courseAttendance || []).map((a) => a.id);
    if (attendanceIds.length === 0) {
      return res.json([]);
    }

    const { data: records, error: recordsError } = await supabase
      .from("attendance_records")
      .select("attendance_id, status")
      .eq("student_id", req.user.id)
      .in("attendance_id", attendanceIds);

    if (recordsError) {
      console.error("[STUDENT ATTENDANCE COURSE] Error fetching records:", recordsError);
      if (recordsError.code === "42P01") {
        return res.json([]);
      }
      throw recordsError;
    }

    // Get attendance sessions to get session_date
    const { data: attendanceSessions, error: sessionsError } = await supabase
      .from("attendance")
      .select("id, session_date")
      .in("id", attendanceIds);

    const sessionMap = new Map();
    if (!sessionsError && attendanceSessions) {
      attendanceSessions.forEach(session => {
        sessionMap.set(session.id, session);
      });
    }

    const mapped = (records || []).map((r) => {
      const session = sessionMap.get(r.attendance_id);
      return {
      sessionId: r.attendance_id,
        date: session?.session_date || "",
      status: r.status || null,
      };
    });

    res.json(mapped);
  } catch (error) {
    console.error("Get course attendance error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/assignments
router.get("/assignments", async (req, res) => {
  try {
    // Get enrolled courses
    const { data: enrollments, error: enrollmentError } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("student_id", req.user.id)
      .not("student_id", "is", null);

    let courseIds = [];

    if (enrollmentError) {
      console.error("[STUDENT ASSIGNMENTS] Error fetching enrollments:", enrollmentError);
      // Try fallback: check user's course_id
      if (req.user.course_id) {
        courseIds = [req.user.course_id];
        console.log(`[STUDENT ASSIGNMENTS] Using fallback course_id: ${req.user.course_id}`);
      } else {
        console.log("[STUDENT ASSIGNMENTS] No enrollments found and no course_id, returning empty array");
        return res.json([]);
      }
    } else {
      courseIds = (enrollments || []).map((e) => e.course_id).filter(Boolean);
    }

    if (courseIds.length === 0) {
      // Fallback: check if user has course_id set
      if (req.user.course_id) {
        courseIds = [req.user.course_id];
        console.log(`[STUDENT ASSIGNMENTS] Using fallback course_id: ${req.user.course_id}`);
      } else {
        console.log("[STUDENT ASSIGNMENTS] No course IDs found, returning empty array");
        return res.json([]);
      }
    }

    console.log(`[STUDENT ASSIGNMENTS] Found ${courseIds.length} course(s) to fetch assignments from`);
    console.log(`[STUDENT ASSIGNMENTS] Course IDs:`, courseIds);

    const { data: assignments, error: assignmentsError } = await supabase
      .from("assignments")
      .select("id, title, description, due_date, course_id, created_by, total_points, created_at")
      .in("course_id", courseIds)
      .order("created_at", { ascending: false });

    if (assignmentsError) {
      console.error("[STUDENT ASSIGNMENTS] Error fetching assignments:", assignmentsError);
      throw assignmentsError;
    }

    // Fetch course names separately (avoiding nested query issues)
    const uniqueCourseIds = [...new Set((assignments || []).map(a => a.course_id).filter(Boolean))];
    const courseMap = new Map();
    if (uniqueCourseIds.length > 0) {
      const { data: courses, error: coursesError } = await supabase
        .from("courses")
        .select("id, name")
        .in("id", uniqueCourseIds);
      
      if (!coursesError && courses) {
        courses.forEach(course => {
          courseMap.set(course.id, course.name);
        });
      }
    }

    console.log(`[STUDENT ASSIGNMENTS] Found ${assignments?.length || 0} assignment(s) for enrolled courses`);
    if (assignments && assignments.length > 0) {
      console.log(`[STUDENT ASSIGNMENTS] Assignment details:`, assignments.map(a => ({
        id: a.id,
        title: a.title,
        course_id: a.course_id,
        created_by: a.created_by,
        course_name: courseMap.get(a.course_id) || "Unknown Course"
      })));
    }

    const assignmentIds = (assignments || []).map((a) => a.id);
    const { data: submissions } = await supabase
      .from("submissions")
      .select("assignment_id, status, files, link, marks, feedback, created_at, updated_at")
      .eq("student_id", req.user.id)
      .in("assignment_id", assignmentIds);

    const submissionMap = new Map();
    (submissions || []).forEach((sub) => {
      submissionMap.set(sub.assignment_id, {
        id: sub.assignment_id,
        status: sub.status,
        score: sub.marks !== null && sub.marks !== undefined ? sub.marks : null,
        feedback: sub.feedback || null,
        files: sub.files || [],
        link: sub.link,
        submittedAt: sub.created_at,
        updatedAt: sub.updated_at,
      });
    });

    const now = new Date();
    const mapped = (assignments || []).map((a) => {
      const courseId = a.course_id || "";
      const courseName = courseId ? (courseMap.get(courseId) || "Unknown Course") : "Unknown Course";
      return {
      id: a.id,
      title: a.title,
      description: a.description,
      dueDate: a.due_date,
        courseId: courseId,
        courseName: courseName,
        totalPoints: a.total_points ?? 100, // Use total_points from database, default to 100 if not set
      submission: submissionMap.get(a.id) || null,
        createdBy: a.created_by, // Include creator info for debugging
        createdAt: a.created_at, // Include creation date
      };
    });

    console.log(`[STUDENT ASSIGNMENTS] Returning ${mapped.length} assignment(s) to student`);
    res.json(mapped);
  } catch (error) {
    console.error("[STUDENT ASSIGNMENTS] Get assignments error:", error);
    console.error("[STUDENT ASSIGNMENTS] Error details:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// POST /student/assignments/:assignmentId/submit
router.post("/assignments/:assignmentId/submit", async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { link, files } = req.body;

    // Check if assignment exists and student is enrolled
    const { data: assignment, error: assignmentError } = await supabase
      .from("assignments")
      .select("course_id")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError) throw assignmentError;
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    const access = await ensureStudentAccess(req.user, assignment.course_id);
    if (access.error) {
      return res.status(access.error.status).json({ message: access.error.message });
    }

    // Check if submission already exists
    const { data: existingSubmission, error: checkError } = await supabase
      .from("submissions")
      .select("id")
      .eq("assignment_id", assignmentId)
      .eq("student_id", req.user.id)
      .maybeSingle();

    if (checkError) {
      console.error("[SUBMIT ASSIGNMENT] Error checking existing submission:", checkError);
      throw checkError;
    }

    let submitError;
    if (existingSubmission) {
      // Update existing submission
      console.log(`[SUBMIT ASSIGNMENT] Updating existing submission: ${existingSubmission.id}`);
      const { error: updateError } = await supabase
        .from("submissions")
        .update({
          status: "Submitted",
          link: link || null,
          files: files || [],
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingSubmission.id);
      submitError = updateError;
    } else {
      // Insert new submission
      console.log(`[SUBMIT ASSIGNMENT] Creating new submission for assignment: ${assignmentId}, student: ${req.user.id}`);
      console.log(`[SUBMIT ASSIGNMENT] Using Supabase client with service role key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO'}`);
      
      // Ensure student_id is a string (UUID as string)
      const submissionData = {
          assignment_id: assignmentId,
        student_id: req.user.id, // This should be a UUID string
          status: "Submitted",
          link: link || null,
          files: files || [],
      };
      
      console.log(`[SUBMIT ASSIGNMENT] Submission data:`, { ...submissionData, files: submissionData.files?.length || 0 });
      
      const { error: insertError, data: insertData } = await supabase
        .from("submissions")
        .insert(submissionData)
        .select();
      
      if (insertData) {
        console.log(`[SUBMIT ASSIGNMENT] Insert successful, data:`, insertData);
      }
      submitError = insertError;
    }

    if (submitError) {
      console.error("[SUBMIT ASSIGNMENT] Error submitting assignment:", submitError);
      console.error("[SUBMIT ASSIGNMENT] Error details:", {
        message: submitError.message,
        code: submitError.code,
        details: submitError.details,
        hint: submitError.hint
      });
      throw submitError;
    }

    res.json({ message: "Assignment submitted successfully" });
  } catch (error) {
    console.error("[SUBMIT ASSIGNMENT] Submit assignment error:", error);
    console.error("[SUBMIT ASSIGNMENT] Error details:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    
    // Return more specific error message
    if (error.code === "42501" || error.message?.includes("row-level security")) {
      return res.status(403).json({ 
        message: "Permission denied. Please contact an administrator.",
        error: error.message 
      });
    }
    
    res.status(500).json({ 
      message: "Server error", 
      error: error.message 
    });
  }
});

// POST /student/upload-assignment-file
// Upload assignment file to storage using service role (bypasses RLS)
router.post("/upload-assignment-file", async (req, res) => {
  try {
    const { fileData, fileName: originalFileName, fileType, studentId } = req.body;
    
    if (!fileData) {
      return res.status(400).json({ message: "No file data provided" });
    }

    if (!studentId || studentId !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized: student ID mismatch" });
    }

    // Handle base64 encoded file (data URL format: data:mime/type;base64,base64data)
    let fileBuffer;
    let mimeType = fileType || 'application/octet-stream';
    
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

    // Validate file size (25MB max for assignments)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (fileBuffer.length > maxSize) {
      return res.status(400).json({ message: "File size exceeds 25MB limit" });
    }

    const fileExt = originalFileName?.split('.').pop() || 'bin';
    const fileName = `${studentId}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${fileExt}`;

    console.log(`[UPLOAD ASSIGNMENT FILE] Uploading file for student: ${studentId}, fileName: ${fileName}`);

    // Upload to Supabase storage using service role key (bypasses RLS)
    const { data, error } = await supabase.storage
      .from('student-submissions')
      .upload(fileName, fileBuffer, {
        contentType: mimeType,
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      console.error('[UPLOAD ASSIGNMENT FILE] Upload error:', error);
      return res.status(500).json({ 
        message: 'Failed to upload file to storage',
        error: error.message 
      });
    }

    // For private buckets, we need to use signed URLs for access
    // Store the file path instead of public URL since bucket is private
    // Generate a signed URL for immediate use (valid for 1 hour)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from('student-submissions')
      .createSignedUrl(fileName, 3600); // Valid for 1 hour

    if (signedUrlError) {
      console.error('[UPLOAD ASSIGNMENT FILE] Signed URL generation error:', signedUrlError);
      // Still return the file path even if signed URL generation fails
      // The frontend can request a signed URL later
    }

    console.log(`[UPLOAD ASSIGNMENT FILE] Upload successful, fileName: ${fileName}`);

    res.json({
      message: 'File uploaded successfully',
      fileUrl: signedUrlData?.signedUrl || null, // Return signed URL if available
      filePath: fileName, // Store file path for later signed URL generation
      fileName: fileName,
    });
  } catch (error) {
    console.error('[UPLOAD ASSIGNMENT FILE] Upload error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /student/assignment-file-url
// Generate a signed URL for accessing an assignment file
router.get("/assignment-file-url", protect, async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ message: "File path is required" });
    }

    // Verify that the file belongs to the requesting student
    // Extract student ID from file path (format: studentId/timestamp-random.ext)
    const pathParts = filePath.split('/');
    if (pathParts.length < 2) {
      return res.status(400).json({ message: "Invalid file path format" });
    }

    const fileStudentId = pathParts[0];
    if (fileStudentId !== req.user.id) {
      return res.status(403).json({ message: "Access denied. You can only access your own files." });
    }

    // Generate signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from('student-submissions')
      .createSignedUrl(filePath, 3600);

    if (signedUrlError) {
      console.error('[ASSIGNMENT FILE URL] Signed URL generation error:', signedUrlError);
      return res.status(500).json({ 
        message: 'Failed to generate file access URL',
        error: signedUrlError.message 
      });
    }

    console.log(`[ASSIGNMENT FILE URL] Generated signed URL for file: ${filePath}`);

    res.json({
      signedUrl: signedUrlData.signedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour from now
    });
  } catch (error) {
    console.error('[ASSIGNMENT FILE URL] Error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /student/notifications
router.get("/notifications", async (req, res) => {
  try {
    const studentId = req.user.id;
    console.log(`\n[STUDENT NOTIFICATIONS] ========================================`);
    console.log(`[STUDENT NOTIFICATIONS] Fetching notifications for student: ${studentId}`);
    console.log(`[STUDENT NOTIFICATIONS] User object:`, {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
      student_id: req.user.student_id
    });
    
    // First, let's check if there are ANY notifications in the table
    // Using service role key, so RLS should not block this
    const { data: allNotifications, error: allError } = await supabase
      .from("notifications")
      .select("id, title, course_id, recipient_id, created_at, type, message")
      .limit(50)
      .order("created_at", { ascending: false });
    
    if (allError) {
      console.error(`[STUDENT NOTIFICATIONS] ❌ Error checking all notifications:`, {
        message: allError.message,
        code: allError.code,
        details: allError.details,
        hint: allError.hint
      });
    } else {
      console.log(`[STUDENT NOTIFICATIONS] Total notifications in database: ${allNotifications?.length || 0}`);
      if (allNotifications && allNotifications.length > 0) {
        console.log(`[STUDENT NOTIFICATIONS] Sample notifications (first 10):`, allNotifications.slice(0, 10).map(n => ({
          id: n.id,
          title: n.title,
          course_id: n.course_id,
          recipient_id: n.recipient_id,
          type: n.type,
          created_at: n.created_at,
          message_preview: n.message?.substring(0, 50) || ''
        })));
        
        // Show course_id distribution
        const courseIdCounts = {};
        allNotifications.forEach(n => {
          const key = n.course_id || 'NULL';
          courseIdCounts[key] = (courseIdCounts[key] || 0) + 1;
        });
        console.log(`[STUDENT NOTIFICATIONS] Course ID distribution:`, courseIdCounts);
        
        // Get enrolled courses for matching check
        const { data: checkEnrollments } = await supabase
          .from("course_students")
          .select("course_id")
          .eq("student_id", studentId)
          .not("student_id", "is", null);
        
        const checkCourseIds = (checkEnrollments || []).map((e) => e.course_id).filter(Boolean);
        
        // Check if any match enrolled courses or are general (course_id IS NULL)
        const matching = allNotifications.filter(n => {
          const matchesCourse = n.course_id && checkCourseIds.includes(n.course_id);
          const isGeneral = n.course_id === null;
          return matchesCourse || isGeneral;
        });
        console.log(`[STUDENT NOTIFICATIONS] Notifications matching enrolled courses (${checkCourseIds.length} courses) or general (course_id IS NULL): ${matching.length}`);
        if (matching.length > 0) {
          console.log(`[STUDENT NOTIFICATIONS] Matching notifications:`, matching.slice(0, 5).map(n => ({
            id: n.id,
            title: n.title,
            recipient_id: n.recipient_id,
            type: n.type
          })));
        } else {
          console.log(`[STUDENT NOTIFICATIONS] ⚠️ No notifications match this student's enrolled courses!`);
          console.log(`[STUDENT NOTIFICATIONS] Student enrolled course IDs:`, checkCourseIds);
          console.log(`[STUDENT NOTIFICATIONS] Available course_ids in DB:`, 
            [...new Set(allNotifications.map(n => n.course_id).filter(Boolean))].slice(0, 10)
          );
          console.log(`[STUDENT NOTIFICATIONS] General notifications (course_id IS NULL):`, 
            allNotifications.filter(n => n.course_id === null).length
          );
          
          // Show a sample of notifications with their course_ids
          const sampleWithCourseIds = allNotifications.slice(0, 5).map(n => ({
            id: n.id,
            title: n.title,
            course_id: n.course_id,
            recipient_id: n.recipient_id
          }));
          console.log(`[STUDENT NOTIFICATIONS] Sample notifications with course_ids:`, sampleWithCourseIds);
        }
      } else {
        console.log(`[STUDENT NOTIFICATIONS] ⚠️ NO NOTIFICATIONS FOUND IN DATABASE`);
        console.log(`[STUDENT NOTIFICATIONS] This means notifications are not being created when:`);
        console.log(`  - Assignments are posted`);
        console.log(`  - Announcements are created`);
        console.log(`  - Resources are uploaded`);
        console.log(`[STUDENT NOTIFICATIONS] Check backend logs when creating these items for notification creation errors`);
      }
    }
    
    // Get all courses the student is enrolled in
    console.log(`[STUDENT NOTIFICATIONS] Fetching enrolled courses for student...`);
    const { data: enrollments, error: enrollmentError } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("student_id", studentId)
      .not("student_id", "is", null);

    if (enrollmentError) {
      console.error(`[STUDENT NOTIFICATIONS] Error fetching enrollments:`, enrollmentError);
    }

    const enrolledCourseIds = (enrollments || []).map((e) => e.course_id).filter(Boolean);
    console.log(`[STUDENT NOTIFICATIONS] Student is enrolled in ${enrolledCourseIds.length} course(s):`, enrolledCourseIds);

    // Simplified logic: Only use course_id, no recipient_id needed
    console.log(`[STUDENT NOTIFICATIONS] Using course-based notification queries (no recipient_id needed)...`);
    
    // Query 1: Course-specific notifications (course_id IN enrolled courses)
    let courseNotifications = [];
    let courseError = null;
    
    if (enrolledCourseIds.length > 0) {
      const { data: courseNotifs, error: courseErr } = await supabase
      .from("notifications")
      .select(
        `
        id,
        title,
        message,
        type,
        created_at,
        read_at,
        sender_id,
          course_id,
        sender:sender_id (
          id,
          name,
          email
        )
      `
      )
        .in("course_id", enrolledCourseIds)
      .order("created_at", { ascending: false });

      courseNotifications = courseNotifs || [];
      courseError = courseErr;

      if (courseError) {
        console.error(`[STUDENT NOTIFICATIONS] ❌ Error fetching course notifications:`, {
          message: courseError.message,
          code: courseError.code,
          details: courseError.details,
          hint: courseError.hint
        });
      } else {
        console.log(`[STUDENT NOTIFICATIONS] Found ${courseNotifications.length} course-specific notification(s)`);
      }
    } else {
      console.log(`[STUDENT NOTIFICATIONS] Student is not enrolled in any courses, skipping course notifications query`);
    }

    // Query 2: General announcements (course_id IS NULL) - shown to everyone
    const { data: generalNotifications, error: generalError } = await supabase
      .from("notifications")
      .select(
        `
        id,
        title,
        message,
        type,
        created_at,
        read_at,
        sender_id,
        course_id,
        sender:sender_id (
          id,
          name,
          email
        )
      `
      )
      .is("course_id", null)
      .order("created_at", { ascending: false });

    if (generalError) {
      console.error(`[STUDENT NOTIFICATIONS] ❌ Error fetching general notifications:`, {
        message: generalError.message,
        code: generalError.code,
        details: generalError.details,
        hint: generalError.hint
      });
    } else {
      console.log(`[STUDENT NOTIFICATIONS] Found ${generalNotifications?.length || 0} general notification(s)`);
    }

    // Combine results from course-specific and general notifications
    const course = courseNotifications || [];
    const general = generalNotifications || [];
    let notifications = [...course, ...general];
    
    // Remove duplicates (in case a notification somehow matches multiple queries)
    const seenIds = new Set();
    notifications = notifications.filter(n => {
      if (seenIds.has(n.id)) {
        return false;
      }
      seenIds.add(n.id);
      return true;
    });
    
    // Sort by created_at descending
    notifications.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    // Determine if there's an error
    const error = courseError || generalError;
    
    console.log(`[STUDENT NOTIFICATIONS] Query results: ${course.length} course-specific + ${general.length} general = ${notifications.length} total (after deduplication)`);

    if (error) {
      console.error("[STUDENT NOTIFICATIONS] ❌ Supabase error:", error);
      console.error("[STUDENT NOTIFICATIONS] Error details:", {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint
      });
      // Return empty array instead of throwing to prevent 500 error
      return res.json([]);
    }

    console.log(`[STUDENT NOTIFICATIONS] ✅ Found ${notifications?.length || 0} notification(s) matching filter`);
    if (notifications && notifications.length > 0) {
      console.log(`[STUDENT NOTIFICATIONS] Sample notification:`, {
        id: notifications[0].id,
        title: notifications[0].title,
        type: notifications[0].type,
        course_id: notifications[0].course_id,
        created_at: notifications[0].created_at
      });
    } else {
      console.log(`[STUDENT NOTIFICATIONS] ⚠️ No notifications found for student ${studentId}`);
      console.log(`[STUDENT NOTIFICATIONS] This could mean:`);
      console.log(`  - No notifications exist in the database`);
      console.log(`  - Student is not enrolled in any courses`);
      console.log(`  - No general notifications (course_id IS NULL) exist`);
      console.log(`  - RLS policies might be blocking access`);
      
      // Try a more specific query to help debug
      if (enrolledCourseIds.length > 0) {
        const { data: specificNotifications } = await supabase
          .from("notifications")
          .select("id, title, course_id, created_at")
          .in("course_id", enrolledCourseIds)
          .limit(5);
        
        console.log(`[STUDENT NOTIFICATIONS] Direct query for course_id IN [${enrolledCourseIds.join(', ')}]: ${specificNotifications?.length || 0} results`);
      }
      
      const { data: nullCourseNotifications } = await supabase
        .from("notifications")
        .select("id, title, course_id, created_at")
        .is("course_id", null)
        .limit(5);
      
      console.log(`[STUDENT NOTIFICATIONS] Direct query for course_id IS NULL: ${nullCourseNotifications?.length || 0} results`);
    }
    console.log(`[STUDENT NOTIFICATIONS] ========================================`);

    const mapped = (notifications || []).map((n) => ({
      id: n.id,
      createdAt: n.created_at,
      title: n.title,
      message: n.message,
      type: n.type || "general",
      courseId: n.course_id || null, // Include course_id in response
      sender: n.sender
        ? {
            id: n.sender.id,
            name: n.sender.name,
            email: n.sender.email,
          }
        : null,
      readAt: n.read_at,
    }));

    console.log(`[STUDENT NOTIFICATIONS] Returning ${mapped.length} mapped notification(s)`);
    
    // If no notifications found, provide helpful debug info in response
    if (mapped.length === 0) {
      console.log(`[STUDENT NOTIFICATIONS] 📋 Summary for debugging:`);
      console.log(`  - Student ID: ${studentId}`);
      console.log(`  - Enrolled in ${enrolledCourseIds.length} course(s): ${enrolledCourseIds.join(', ') || 'none'}`);
      console.log(`  - Total notifications in DB: ${allNotifications?.length || 0}`);
      console.log(`  - Course-specific notifications found: ${course.length}`);
      console.log(`  - General notifications found: ${general.length}`);
      console.log(`  - Combined notifications: ${notifications?.length || 0}`);
      console.log(`  - Course query error: ${courseError ? courseError.message : 'none'}`);
      console.log(`  - General query error: ${generalError ? generalError.message : 'none'}`);
    }
    
    // Prevent caching of notifications to ensure fresh data
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.json(mapped);
  } catch (error) {
    console.error("[STUDENT NOTIFICATIONS] Get notifications error:", error);
    console.error("[STUDENT NOTIFICATIONS] Error stack:", error.stack);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// PUT /student/notifications/:notificationId/read
router.put("/notifications/:notificationId/read", async (req, res) => {
  try {
    const { notificationId } = req.params;

    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("recipient_id", req.user.id);

    if (error) throw error;

    res.json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Mark notification as read error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /student/notifications/read-all
router.put("/notifications/read-all", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", req.user.id)
      .is("read_at", null)
      .select("id");

    if (error) throw error;

    res.json({ message: "All notifications marked as read", count: (data || []).length });
  } catch (error) {
    console.error("Mark all notifications as read error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/announcements
router.get("/announcements", async (req, res) => {
  try {
    const { data: announcements, error } = await supabase
      .from("announcements")
      .select(
        `
        id,
        title,
        body,
        pinned,
        created_at,
        course_id,
        author_id,
        course:course_id (
          id,
          name
        ),
        author:author_id (
          id,
          name
        )
      `
      )
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) throw error;

    const mapped = (announcements || []).map((a) => ({
      id: a.id,
      createdAt: a.created_at,
      title: a.title,
      body: a.body,
      pinned: a.pinned || false,
      course: a.course
        ? {
            id: a.course.id,
            name: a.course.name,
          }
        : null,
      author: a.author
        ? {
            id: a.author.id,
            name: a.author.name,
          }
        : null,
    }));

    res.json(mapped);
  } catch (error) {
    console.error("Get announcements error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/timetable/today
router.get("/timetable/today", async (req, res) => {
  try {
    const today = new Date();
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const todayName = dayNames[today.getDay()];
    const todayNameCapitalized = todayName.charAt(0).toUpperCase() + todayName.slice(1); // "Tuesday"

    console.log(`[TODAY TIMETABLE] Today is: ${todayName} (also checking: ${todayNameCapitalized})`);

    // Get enrolled courses
    const { data: enrollments, error: enrollmentError } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("student_id", req.user.id);

    if (enrollmentError) {
      console.error("[TODAY TIMETABLE] Error fetching enrollments:", enrollmentError);
    }

    const courseIds = (enrollments || []).map((e) => e.course_id).filter(Boolean);
    console.log(`[TODAY TIMETABLE] Found ${courseIds.length} enrolled courses`);
    
    if (courseIds.length === 0) {
      console.log("[TODAY TIMETABLE] No enrolled courses, returning empty array");
      return res.json([]);
    }

    // Get all slots for enrolled courses (we'll filter by day in JavaScript to handle case sensitivity)
    const { data: allSlots, error: slotsError } = await supabase
      .from("course_schedule_slots")
      .select(
        `
        id,
        course_id,
        day_of_week,
        start_time,
        end_time,
        location,
        notes,
        teacher_id,
        course:course_id (
          name
        ),
        teacher:teacher_id (
          name
        )
      `
      )
      .in("course_id", courseIds)
      .order("start_time", { ascending: true });

    if (slotsError) {
      console.error("[TODAY TIMETABLE] Error fetching slots:", slotsError);
      throw slotsError;
    }

    // Filter slots for today (case-insensitive comparison)
    const todaySlots = (allSlots || []).filter(slot => {
      const slotDay = (slot.day_of_week || '').toLowerCase();
      return slotDay === todayName;
    });

    console.log(`[TODAY TIMETABLE] Found ${todaySlots.length} slots for today out of ${allSlots?.length || 0} total slots`);

    const mapped = todaySlots.map((s) => ({
      id: s.id,
      courseId: s.course_id,
      courseName: s.course?.name || "Unknown Course",
      teacherId: s.teacher_id,
      teacherName: s.teacher?.name || "Unknown Teacher",
      dayOfWeek: s.day_of_week,
      startTime: s.start_time,
      endTime: s.end_time,
      location: s.location,
      notes: s.notes,
    }));

    console.log(`[TODAY TIMETABLE] Returning ${mapped.length} classes for today`);
    res.json(mapped);
  } catch (error) {
    console.error("Get today timetable error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /student/timetable - Full weekly timetable
router.get("/timetable", async (req, res) => {
  try {
    // Get enrolled courses
    const { data: enrollments } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("student_id", req.user.id);

    const courseIds = (enrollments || []).map((e) => e.course_id);
    if (courseIds.length === 0) {
      return res.json([]);
    }

    const { data: slots, error } = await supabase
      .from("course_schedule_slots")
      .select(
        `
        id,
        course_id,
        day_of_week,
        start_time,
        end_time,
        location,
        notes,
        teacher_id,
        course:course_id (
          name
        ),
        teacher:teacher_id (
          name
        )
      `
      )
      .in("course_id", courseIds)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) {
      if (error.code === "42P01") {
        return res.json([]);
      }
      throw error;
    }

    const mapped = (slots || []).map((s) => ({
      id: s.id,
      courseId: s.course_id,
      courseName: s.course?.name || "Unknown Course",
      teacherId: s.teacher_id,
      teacherName: s.teacher?.name || "Unknown Teacher",
      dayOfWeek: s.day_of_week,
      startTime: s.start_time,
      endTime: s.end_time,
      location: s.location,
      notes: s.notes,
    }));

    res.json(mapped);
  } catch (error) {
    console.error("Get timetable error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
