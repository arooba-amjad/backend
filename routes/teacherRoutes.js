import express from "express";
import { protect, authorizeRoles } from "../middleware/authMiddleware.js";
import { supabase } from "../config/supabaseClient.js";

const router = express.Router();

router.use(protect, authorizeRoles("teacher"));

const ensureCourseOwnership = async (teacherId, courseId) => {
  const { data, error } = await supabase
    .from("courses")
    .select("id, name")
    .eq("id", courseId)
    .eq("teacher_id", teacherId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    const { data: exists, error: existsError } = await supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .maybeSingle();

    if (existsError) {
      throw existsError;
    }

    if (!exists) {
      return {
        course: null,
        error: { status: 404, message: "Course not found" },
      };
  }

    return {
      course: null,
      error: { status: 403, message: "You do not manage this course" },
    };
  }

  return { course: data };
};

const mapCourse = (row) => ({
  _id: row.id,
  name: row.name,
  description: row.description,
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

const mapAssignment = (row) => ({
  _id: row.id,
  title: row.title,
  description: row.description,
  dueDate: row.due_date,
  courseId: row.course_id,
  createdBy: row.created_by,
  totalPoints: row.total_points ?? 100, // Default to 100 if not set
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapResource = (row) => ({
  _id: row.id,
  title: row.title,
  type: row.type,
  description: row.description ?? row.metadata?.description ?? null,
  fileUrl: row.file_url,
  courseId: row.course_id,
  uploadedBy: row.uploaded_by,
  visibilityScope: row.visibility_scope ?? "course",
  visibleTeacherId: row.visible_teacher_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapSubmission = (row) => {
  if (!row) return null;
  
  return {
    _id: row.id,
    assignmentId: row.assignment_id,
    studentId: row.student_id,
    link: row.link || null,
    files: row.files ?? [],
    status: row.status || 'Pending',
    marks: row.marks ?? null,
    feedback: row.feedback ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    student: row.student
      ? {
          _id: row.student.id,
          name: row.student.name,
          email: row.student.email,
          studentId: row.student.student_id,
        }
      : undefined,
    assignment: row.assignment && row.assignment.id
      ? {
          _id: row.assignment.id,
          title: row.assignment.title || null,
          courseId: row.assignment.course_id || null,
          totalPoints: row.assignment.total_points ?? 100,
        }
      : undefined,
  };
};

const mapAttendance = (row) => ({
  _id: row.id,
  courseId: row.course_id,
  date: row.session_date,
  records: (row.records ?? []).map((record) => ({
    studentId: record.student_id,
    status: record.status,
  })),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// GET /teacher/courses/:courseId/schedule-slots
router.get("/courses/:courseId/schedule-slots", async (req, res) => {
  try {
    const { courseId } = req.params;

    // Verify course ownership
    const { course, error: courseError } = await ensureCourseOwnership(req.user.id, courseId);
    if (courseError) {
      return res.status(courseError.status).json({ message: courseError.message });
    }

    // Fetch schedule slots for this course
    const { data: slots, error: slotsError } = await supabase
      .from("course_schedule_slots")
      .select("id, day_of_week, start_time, end_time")
      .eq("course_id", courseId)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    if (slotsError) {
      if (slotsError.code === "42P01") {
        // Table doesn't exist, return empty array
        return res.json([]);
      }
      throw slotsError;
    }

    res.json((slots || []).map((slot) => ({
      id: slot.id,
      dayOfWeek: slot.day_of_week,
      startTime: slot.start_time,
      endTime: slot.end_time,
    })));
  } catch (error) {
    console.error("Get course schedule slots error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/courses", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("courses")
      .select(
        `
        id,
        name,
        description,
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
      .eq("teacher_id", req.user.id)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    res.json((data ?? []).map(mapCourse));
  } catch (error) {
    console.error("Teacher courses error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/createAssignment", async (req, res) => {
  try {
    const { title, description, dueDate, courseId, totalPoints } = req.body;

    if (!title || !dueDate || !courseId) {
      return res
        .status(400)
        .json({ message: "Title, due date, and course ID are required" });
    }

    const { course, error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    // Validate totalPoints if provided
    const points = totalPoints !== undefined && totalPoints !== null && totalPoints !== '' 
      ? parseFloat(totalPoints) 
      : 100; // Default to 100 if not provided
    
    if (isNaN(points) || points <= 0) {
      return res.status(400).json({ message: "Total points must be a positive number" });
    }

    const { data: assignmentRow, error: insertError } = await supabase
      .from("assignments")
      .insert({
        title,
        description: description || "",
        due_date: new Date(dueDate).toISOString(),
        course_id: course.id,
        created_by: req.user.id,
        total_points: points,
      })
      .select(
        `
        id,
      title,
      description,
        due_date,
        course_id,
        created_by,
        total_points,
        created_at,
        updated_at
      `
      )
      .single();

    if (insertError) {
      throw insertError;
    }

    // Create notifications for enrolled students
    const { data: enrollmentRows } = await supabase
      .from("course_students")
      .select("student_id")
      .eq("course_id", course.id);

    const studentIds = (enrollmentRows ?? []).map((row) => row.student_id);

    if (studentIds.length > 0) {
      const notifications = studentIds.map((studentId) => ({
        recipient_id: studentId,
        title: "New Assignment Posted",
        message: `${title} has been posted for ${course.name}. Due: ${new Date(dueDate).toLocaleDateString()}`,
        type: "assignment",
        sender_id: req.user.id,
        channels: ["in_app"],
        audience_scope: "course",
        course_id: course.id,
      }));

      const { data: insertedNotifications, error: notificationError } = await supabase
        .from("notifications")
        .insert(notifications)
        .select("id, recipient_id, title");

      if (notificationError) {
        console.error("[CREATE ASSIGNMENT] ❌ Failed to create assignment notifications:", notificationError);
        console.error("[CREATE ASSIGNMENT] Error details:", {
          message: notificationError.message,
          code: notificationError.code,
          details: notificationError.details,
          hint: notificationError.hint
        });
        // Don't fail the request if notification fails
      } else {
        console.log(`[CREATE ASSIGNMENT] ✅ Created ${insertedNotifications?.length || 0} notification(s) for ${studentIds.length} student(s)`);
        if (insertedNotifications && insertedNotifications.length > 0) {
          console.log(`[CREATE ASSIGNMENT] Sample notification:`, insertedNotifications[0]);
        }
      }
    }

    const io = req.app.get("io");
    io?.emit(`assignment-update-${course.id}`, mapAssignment(assignmentRow));

    res.status(201).json({
      message: "Assignment created",
      assignment: mapAssignment(assignmentRow),
    });
  } catch (error) {
    console.error("Create assignment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/assignments", async (req, res) => {
  try {
    const { data: courseRows, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", req.user.id);

    if (coursesError) {
      throw coursesError;
    }

    const courseIds = (courseRows ?? []).map((row) => row.id);

    if (!courseIds.length) {
      return res.json([]);
    }

    const { data, error: fetchError } = await supabase
      .from("assignments")
      .select(
        `
        id,
        title,
        description,
        due_date,
        course_id,
        created_by,
        total_points,
        created_at,
        updated_at,
        course:course_id (
          id,
          name
        )
      `
      )
      .in("course_id", courseIds)
      .order("due_date", { ascending: true });

    if (fetchError) {
      throw fetchError;
    }

    res.json((data ?? []).map((row) => ({
      ...mapAssignment(row),
      courseName: row.course?.name || "Unknown Course",
    })));
  } catch (error) {
    console.error("Get all assignments error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/assignments/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;

    const { error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const { data, error: fetchError } = await supabase
      .from("assignments")
      .select(
        `
        id,
        title,
        description,
        due_date,
        course_id,
        created_by,
        total_points,
        created_at,
        updated_at
      `
      )
      .eq("course_id", courseId)
      .order("due_date", { ascending: true });

    if (fetchError) {
      throw fetchError;
    }

    res.json((data ?? []).map(mapAssignment));
  } catch (error) {
    console.error("Get assignments error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/assignments/:assignmentId", async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const { title, description, dueDate, courseId, totalPoints } = req.body;

    const { data: assignmentRow, error: assignmentError } = await supabase
      .from("assignments")
      .select("id, course_id, created_by")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError) {
      throw assignmentError;
    }

    if (!assignmentRow) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    if (assignmentRow.created_by !== req.user.id) {
      return res.status(403).json({ message: "You can only edit your own assignments" });
    }

    const { error: ownershipError } = await ensureCourseOwnership(
      req.user.id,
      courseId || assignmentRow.course_id
    );
    if (ownershipError) {
      return res.status(ownershipError.status).json({ message: ownershipError.message });
    }

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description || "";
    if (dueDate !== undefined) updates.due_date = new Date(dueDate).toISOString();
    if (courseId !== undefined) updates.course_id = courseId;
    if (totalPoints !== undefined && totalPoints !== null && totalPoints !== '') {
      const points = parseFloat(totalPoints);
      if (!isNaN(points) && points > 0) {
        updates.total_points = points;
      }
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("assignments")
      .update(updates)
      .eq("id", assignmentId)
      .select(
        `
        id,
        title,
        description,
        due_date,
        course_id,
        created_by,
        total_points,
        created_at,
        updated_at
      `
      )
      .single();

    if (updateError) {
      throw updateError;
    }

    const io = req.app.get("io");
    io?.emit(`assignment-update-${updatedRow.course_id}`, mapAssignment(updatedRow));

    res.json({
      message: "Assignment updated",
      assignment: mapAssignment(updatedRow),
    });
  } catch (error) {
    console.error("Update assignment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/assignments/:assignmentId", async (req, res) => {
  try {
    const { assignmentId } = req.params;

    const { data: assignmentRow, error: assignmentError } = await supabase
      .from("assignments")
      .select("id, course_id, created_by")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError) {
      throw assignmentError;
    }

    if (!assignmentRow) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    if (assignmentRow.created_by !== req.user.id) {
      return res.status(403).json({ message: "You can only delete your own assignments" });
    }

    const { error: deleteError } = await supabase
      .from("assignments")
      .delete()
      .eq("id", assignmentId);

    if (deleteError) {
      throw deleteError;
    }

    const io = req.app.get("io");
    io?.emit(`assignment-delete-${assignmentRow.course_id}`, { id: assignmentId });

    res.json({ message: "Assignment deleted" });
  } catch (error) {
    console.error("Delete assignment error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/markAttendance", async (req, res) => {
  try {
    const { courseId, date, records } = req.body;

    if (!courseId || !date || !Array.isArray(records)) {
      return res
        .status(400)
        .json({ message: "Course ID, date, and records are required" });
    }

    const { course, error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const sessionDate = new Date(date).toISOString().slice(0, 10);
    
    // Validate that the selected date matches a scheduled class day
    const selectedDate = new Date(date);
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const selectedDayName = dayNames[selectedDate.getDay()];
    
    // Check if there's a scheduled class on this day for this course
    // Fetch all slots for the course and filter by day (case-insensitive)
    const { data: allScheduleSlots, error: scheduleError } = await supabase
      .from("course_schedule_slots")
      .select("id, day_of_week")
      .eq("course_id", courseId);
    
    // If table doesn't exist, allow attendance (backward compatibility)
    if (scheduleError && scheduleError.code === "42P01") {
      console.warn("[Mark Attendance] course_schedule_slots table not found, skipping schedule validation");
    } else if (scheduleError) {
      throw scheduleError;
    } else {
      // Filter slots by day (case-insensitive comparison)
      const matchingSlots = (allScheduleSlots || []).filter(
        slot => slot.day_of_week && slot.day_of_week.toLowerCase() === selectedDayName.toLowerCase()
      );
      
      if (matchingSlots.length === 0) {
        return res.status(400).json({ 
          message: `No class is scheduled for ${course.name} on ${selectedDayName}. Please select a date when a class is scheduled.` 
        });
      }
    }

    const { data: attendanceRow, error: upsertError } = await supabase
      .from("attendance")
      .upsert(
        {
          course_id: course.id,
          session_date: sessionDate,
        },
        { onConflict: "course_id,session_date" }
      )
      .select("id, course_id, session_date, created_at, updated_at")
      .single();

    if (upsertError) {
      throw upsertError;
    }

    const { error: deleteError } = await supabase
      .from("attendance_records")
      .delete()
      .eq("attendance_id", attendanceRow.id);

    if (deleteError) {
      throw deleteError;
    }

    if (records.length) {
      const { error: insertRecordError } = await supabase
        .from("attendance_records")
        .insert(
          records.map((record) => ({
            attendance_id: attendanceRow.id,
            student_id: record.studentId,
            status: record.status,
          }))
        );

      if (insertRecordError) {
        throw insertRecordError;
      }
    }

    const { data: finalAttendance, error: finalFetchError } = await supabase
      .from("attendance")
      .select(
        `
        id,
        course_id,
        session_date,
        created_at,
        updated_at,
        records:attendance_records (
          student_id,
          status
        )
      `
      )
      .eq("id", attendanceRow.id)
      .single();

    if (finalFetchError) {
      throw finalFetchError;
    }

    const mapped = mapAttendance(finalAttendance);

    const io = req.app.get("io");
    io?.emit(`attendance-update-${course.id}`, mapped);

    res.json({ message: "Attendance recorded", attendance: mapped });
  } catch (error) {
    console.error("Mark attendance error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/uploadResource", async (req, res) => {
  try {
    const { title, type, fileUrl, courseId, description } = req.body;

    if (!title || !fileUrl || !courseId) {
      return res
        .status(400)
        .json({ message: "Title, file URL, and course ID are required" });
    }

    const { course, error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const { data: resourceRow, error: insertError } = await supabase
      .from("resources")
      .insert({
      title,
        description: description || "",
        type: type || "link",
        file_url: fileUrl,
        course_id: course.id,
        uploaded_by: req.user.id,
        visibility_scope: "course",
      })
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
        updated_at
      `
      )
      .single();

    if (insertError) {
      throw insertError;
    }

    // Create notifications for enrolled students
    const { data: enrollmentRows } = await supabase
      .from("course_students")
      .select("student_id")
      .eq("course_id", course.id);

    const studentIds = (enrollmentRows ?? []).map((row) => row.student_id);

    if (studentIds.length > 0) {
      const notifications = studentIds.map((studentId) => ({
        recipient_id: studentId,
        title: "New Resource Available",
        message: `${title} has been uploaded for ${course.name}`,
        type: "resource",
        sender_id: req.user.id,
        channels: ["in_app"],
        audience_scope: "course",
        course_id: course.id,
      }));

      const { error: notificationError } = await supabase
        .from("notifications")
        .insert(notifications);

      if (notificationError) {
        console.error("Failed to create resource notifications:", notificationError);
        // Don't fail the request if notification fails
      }
    }

    const mapped = mapResource(resourceRow);

    const io = req.app.get("io");
    io?.emit(`resource-update-${course.id}`, mapped);
    io?.emit("admin-notes-refresh", {
      courseId: course.id,
      noteId: mapped._id,
      source: "teacher",
    });

    res.status(201).json({
      message: "Resource uploaded",
      resource: mapped,
    });
  } catch (error) {
    console.error("Upload resource error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/resources", async (req, res) => {
  try {
    const { data: courseRows, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", req.user.id);

    if (coursesError) {
      throw coursesError;
    }

    const courseIds = (courseRows ?? []).map((row) => row.id);

    // Fetch resources from resources table (teacher-uploaded)
    const resourcesQuery = courseIds.length > 0
      ? supabase
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
            )
          `
          )
          .in("course_id", courseIds)
          .order("created_at", { ascending: false })
      : { data: [], error: null };

    const { data: resourcesData, error: resourcesError } = await resourcesQuery;

    if (resourcesError) {
      throw resourcesError;
    }

    // Fetch admin notes assigned to this teacher or their courses
    const adminNotesConditions = [];
    
    // Notes assigned specifically to this teacher
    adminNotesConditions.push(
      supabase
        .from("admin_notes")
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          course_id,
          teacher_id,
          visibility_scope,
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
        .eq("teacher_id", req.user.id)
        .order("created_at", { ascending: false })
    );

    // Notes for courses this teacher manages (if they have courses)
    if (courseIds.length > 0) {
      adminNotesConditions.push(
        supabase
          .from("admin_notes")
          .select(
            `
            id,
            title,
            description,
            type,
            file_url,
            course_id,
            teacher_id,
            visibility_scope,
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
          .in("course_id", courseIds)
          .is("teacher_id", null)
          .in("visibility_scope", ["course", "global"])
          .order("created_at", { ascending: false })
      );
    }

    // Global notes (no specific teacher or course)
    adminNotesConditions.push(
      supabase
        .from("admin_notes")
        .select(
          `
          id,
          title,
          description,
          type,
          file_url,
          course_id,
          teacher_id,
          visibility_scope,
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
        .eq("visibility_scope", "global")
        .is("teacher_id", null)
        .is("course_id", null)
        .order("created_at", { ascending: false })
    );

    const adminNotesResults = await Promise.all(adminNotesConditions);
    const adminNotesData = [];
    const seenNoteIds = new Set();

    for (const result of adminNotesResults) {
      if (result.error && result.error.code !== "42P01") {
        // Ignore table not found errors, but log others
        console.warn("Error fetching admin notes:", result.error);
        continue;
      }

      if (result.data) {
        for (const note of result.data) {
          if (!seenNoteIds.has(note.id)) {
            seenNoteIds.add(note.id);
            adminNotesData.push(note);
          }
        }
      }
    }

    // Map admin notes to resource format
    const mappedAdminNotes = adminNotesData.map((note) => ({
      id: note.id,
      title: note.title,
      description: note.description || note.metadata?.description || null,
      type: note.type || "document",
      fileUrl: note.file_url,
      courseId: note.course_id,
      courseName: note.course?.name || "Unknown Course",
      uploadedBy: note.creator
        ? {
            id: note.creator.id,
            name: note.creator.name,
            role: note.creator.role || "admin",
          }
        : null,
      source: "admin",
      createdAt: note.created_at,
      updatedAt: note.updated_at,
    }));

    // Map regular resources
    const mappedResources = (resourcesData ?? []).map((row) => ({
      ...mapResource(row),
      courseName: row.course?.name || "Unknown Course",
    }));

    // Combine and sort by creation date
    const allResources = [...mappedResources, ...mappedAdminNotes].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    res.json(allResources);
  } catch (error) {
    console.error("Get all resources error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.get("/resources/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;

    const { error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const { data, error: fetchError } = await supabase
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
        updated_at
      `
      )
      .eq("course_id", courseId)
      .order("created_at", { ascending: false });

    if (fetchError) {
      throw fetchError;
    }

    res.json((data ?? []).map(mapResource));
  } catch (error) {
    console.error("Get resources error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/submissions", async (req, res) => {
  try {
    const { assignmentId } = req.query;

    if (assignmentId) {
      const { data: assignmentRow, error: assignmentError } = await supabase
        .from("assignments")
        .select("id, course_id")
        .eq("id", assignmentId)
        .maybeSingle();

      if (assignmentError) {
        console.error("Assignment lookup error:", assignmentError);
        throw assignmentError;
      }

      if (!assignmentRow) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      const { error } = await ensureCourseOwnership(
        req.user.id,
        assignmentRow.course_id
      );
      if (error) {
        return res.status(error.status).json({ message: error.message });
      }

      // Fetch submissions without foreign key joins first
      const { data: submissionsData, error: fetchError } = await supabase
        .from("submissions")
        .select("id, assignment_id, student_id, link, files, status, created_at, updated_at")
        .eq("assignment_id", assignmentId)
        .order("created_at", { ascending: true });

      if (fetchError) {
        console.error("Submissions fetch error (with assignmentId):", fetchError);
        throw fetchError;
      }

      if (!submissionsData || submissionsData.length === 0) {
        return res.json([]);
      }

      // Fetch student and assignment details separately
      const studentIds = [...new Set(submissionsData.map(s => s.student_id).filter(Boolean))];
      
      let studentsResult = { data: [], error: null };
      if (studentIds.length > 0) {
        studentsResult = await supabase.from("users").select("id, name, email, student_id").in("id", studentIds);
        if (studentsResult.error) {
          console.error("[Submissions] Error fetching students:", studentsResult.error);
          studentsResult.data = [];
        }
      }

      let assignmentResult = { data: null, error: null };
      try {
        assignmentResult = await supabase.from("assignments").select("id, title, course_id").eq("id", assignmentId).maybeSingle();
        if (assignmentResult.error) {
          console.error("[Submissions] Error fetching assignment:", assignmentResult.error);
        }
      } catch (err) {
        console.error("[Submissions] Exception fetching assignment:", err);
        assignmentResult = { data: null, error: err };
      }

      const studentsMap = new Map((studentsResult.data || []).map(s => [s.id, s]));

      // Combine the data
      const data = submissionsData.map(submission => ({
        ...submission,
        student: studentsMap.get(submission.student_id) || null,
        assignment: assignmentResult.data || null
      }));

      const mapped = (data ?? []).map(mapSubmission).filter(Boolean);
      return res.json(mapped);
    }

    const { data: courseRows, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", req.user.id);

    if (coursesError) {
      console.error("[Submissions] Error fetching teacher's courses:", coursesError);
      throw coursesError;
    }

    const courseIds = (courseRows ?? []).map((row) => row.id);

    if (!courseIds.length) {
      console.log("[Submissions] Teacher has no courses, returning empty array");
      return res.json([]);
    }

    console.log(`[Submissions] Teacher has ${courseIds.length} courses`);

    const { data: assignmentRows, error: assignmentsError } = await supabase
      .from("assignments")
      .select("id")
      .in("course_id", courseIds);

    if (assignmentsError) {
      console.error("[Submissions] Error fetching assignments:", assignmentsError);
      throw assignmentsError;
    }

    const assignmentIds = (assignmentRows ?? []).map((row) => row.id);

    if (!assignmentIds.length) {
      console.log("[Submissions] No assignments found for teacher's courses, returning empty array");
      return res.json([]);
    }

    console.log(`[Submissions] Fetching submissions for ${assignmentIds.length} assignments:`, assignmentIds);

    // Ensure assignmentIds is an array and not empty before querying
    if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      console.log("[Submissions] Invalid assignmentIds array, returning empty array");
      return res.json([]);
    }

    // First, get submissions without foreign key joins to avoid relationship errors
    // Filter out any null/undefined/invalid values from assignmentIds
    const validAssignmentIds = assignmentIds.filter(id => {
      return id != null && id !== '' && (typeof id === 'string' || typeof id === 'number');
    });
    
    console.log(`[Submissions] Total assignment IDs: ${assignmentIds.length}, Valid: ${validAssignmentIds.length}`);
    
    if (!validAssignmentIds.length) {
      console.log("[Submissions] No valid assignment IDs, returning empty array");
      return res.json([]);
    }
    
    console.log(`[Submissions] Querying submissions for assignment IDs:`, validAssignmentIds.slice(0, 5), validAssignmentIds.length > 5 ? '...' : '');
    
    const { data: submissionsData, error: fetchError } = await supabase
      .from("submissions")
      .select("id, assignment_id, student_id, link, files, status, marks, feedback, created_at, updated_at")
      .in("assignment_id", validAssignmentIds)
      .order("created_at", { ascending: false });

    if (fetchError) {
      console.error("[Submissions] Fetch error details:", {
        message: fetchError.message,
        details: fetchError.details,
        hint: fetchError.hint,
        code: fetchError.code
      });
      throw fetchError;
    }

    if (!submissionsData || submissionsData.length === 0) {
      console.log("[Submissions] No data returned, returning empty array");
      return res.json([]);
    }

    // Now fetch student and assignment details separately
    const studentIds = [...new Set(submissionsData.map(s => s.student_id).filter(Boolean))];
    const assignmentIdsFromSubmissions = [...new Set(submissionsData.map(s => s.assignment_id).filter(Boolean))];

    let studentsResult = { data: [], error: null };
    let assignmentsResult = { data: [], error: null };

    try {
      if (studentIds.length > 0) {
        studentsResult = await supabase.from("users").select("id, name, email, student_id").in("id", studentIds);
        if (studentsResult.error) {
          console.error("[Submissions] Error fetching students:", studentsResult.error);
          // Continue with empty students array rather than failing
          studentsResult.data = [];
        }
      }
    } catch (err) {
      console.error("[Submissions] Exception fetching students:", err);
      studentsResult = { data: [], error: err };
    }

    try {
      if (assignmentIdsFromSubmissions.length > 0) {
        assignmentsResult = await supabase.from("assignments").select("id, title, course_id, total_points").in("id", assignmentIdsFromSubmissions);
        if (assignmentsResult.error) {
          console.error("[Submissions] Error fetching assignments:", assignmentsResult.error);
          // Continue with empty assignments array rather than failing
          assignmentsResult.data = [];
        }
      }
    } catch (err) {
      console.error("[Submissions] Exception fetching assignments:", err);
      assignmentsResult = { data: [], error: err };
    }

    const studentsMap = new Map((studentsResult.data || []).map(s => [s.id, s]));
    const assignmentsMap = new Map((assignmentsResult.data || []).map(a => [a.id, a]));

    // Combine the data
    const data = submissionsData.map(submission => ({
      ...submission,
      student: studentsMap.get(submission.student_id) || null,
      assignment: assignmentsMap.get(submission.assignment_id) || null
    }));

    console.log(`[Submissions] Successfully fetched ${data.length} submissions`);
    const mapped = (data ?? []).map(mapSubmission).filter(Boolean);
    res.json(mapped);
  } catch (error) {
    console.error("[Submissions] Get all submissions error:", error);
    console.error("[Submissions] Error type:", typeof error);
    console.error("[Submissions] Error stack:", error?.stack);
    console.error("[Submissions] Error name:", error?.name);
    console.error("[Submissions] Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    const errorMessage = error?.message || error?.toString() || "Failed to fetch submissions";
    const errorDetails = error?.details || error?.hint || error;
    
    console.error("[Submissions] Error message:", errorMessage);
    console.error("[Submissions] Error details:", errorDetails);
    
    res.status(500).json({ 
      message: errorMessage,
      status: 500,
      details: process.env.NODE_ENV === 'development' ? {
        message: errorMessage,
        name: error?.name,
        code: error?.code,
        hint: error?.hint,
        stack: error?.stack,
        details: errorDetails
      } : { message: errorMessage }
    });
  }
});

router.get("/submissions/:assignmentId", async (req, res) => {
  try {
    const { assignmentId } = req.params;

    const { data: assignmentRow, error: assignmentError } = await supabase
      .from("assignments")
      .select("id, course_id")
      .eq("id", assignmentId)
      .maybeSingle();

    if (assignmentError) {
      throw assignmentError;
    }

    if (!assignmentRow) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    const { error } = await ensureCourseOwnership(
      req.user.id,
      assignmentRow.course_id
    );
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    // Fetch submissions without foreign key joins first
    const { data: submissionsData, error: fetchError } = await supabase
      .from("submissions")
      .select("id, assignment_id, student_id, link, files, status, marks, feedback, created_at, updated_at")
      .eq("assignment_id", assignmentId)
      .order("created_at", { ascending: true });

    if (fetchError) {
      throw fetchError;
    }

    if (!submissionsData || submissionsData.length === 0) {
      return res.json([]);
    }

    // Fetch student details separately
    const studentIds = [...new Set(submissionsData.map(s => s.student_id).filter(Boolean))];
    let studentsResult = { data: [], error: null };
    try {
      if (studentIds.length > 0) {
        studentsResult = await supabase.from("users").select("id, name, email, student_id").in("id", studentIds);
        if (studentsResult.error) {
          console.error("[Submissions] Error fetching students:", studentsResult.error);
          studentsResult.data = [];
        }
      }
    } catch (err) {
      console.error("[Submissions] Exception fetching students:", err);
      studentsResult = { data: [], error: err };
    }

    const studentsMap = new Map((studentsResult.data || []).map(s => [s.id, s]));

    // Fetch assignment details for total_points
    const { data: assignmentData } = await supabase
      .from("assignments")
      .select("id, title, course_id, total_points")
      .eq("id", assignmentId)
      .maybeSingle();

    // Combine the data
    const data = submissionsData.map(submission => ({
      ...submission,
      student: studentsMap.get(submission.student_id) || null,
      assignment: assignmentData ? {
        id: assignmentData.id,
        title: assignmentData.title,
        course_id: assignmentData.course_id,
        total_points: assignmentData.total_points ?? 100,
      } : null
    }));

    const mapped = (data ?? []).map(mapSubmission).filter(Boolean);
    res.json(mapped);
  } catch (error) {
    console.error("Get submissions error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/submissions/:submissionId", async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { status, marks, feedback } = req.body;

    const { data: submissionRow, error: submissionError } = await supabase
      .from("submissions")
      .select(
        `
        id,
        assignment_id,
        assignment:assignments (
          id,
          course_id
        )
      `
      )
      .eq("id", submissionId)
      .maybeSingle();

    if (submissionError) {
      throw submissionError;
    }

    if (!submissionRow) {
      return res.status(404).json({ message: "Submission not found" });
    }

    const { error: ownershipError } = await ensureCourseOwnership(
      req.user.id,
      submissionRow.assignment?.course_id
    );
    if (ownershipError) {
      return res.status(ownershipError.status).json({ message: ownershipError.message });
    }

    const updates = {};
    if (status !== undefined) updates.status = status;
    // Try to update marks column (will work after running add_marks_column_to_submissions.sql)
    if (marks !== undefined) {
      updates.marks = marks !== null && marks !== "" ? parseFloat(marks) : null;
    }
    // Try to update feedback column (will work after running add_marks_column_to_submissions.sql)
    if (feedback !== undefined) {
      updates.feedback = feedback !== null && feedback !== "" ? String(feedback) : null;
    }

    const { data: updatedRow, error: updateError } = await supabase
      .from("submissions")
      .update(updates)
      .eq("id", submissionId)
      .select(
        `
        id,
        assignment_id,
        student_id,
        link,
        files,
        status,
        marks,
        feedback,
        created_at,
        updated_at,
        student:users (
          id,
          name,
          email,
          student_id
        )
      `
      )
      .single();

    if (updateError) {
      throw updateError;
    }

    const io = req.app.get("io");
    io?.emit(`submission-update-${submissionRow.assignment_id}`, mapSubmission(updatedRow));

    res.json({
      message: "Submission updated",
      submission: mapSubmission(updatedRow),
    });
  } catch (error) {
    console.error("Update submission error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/submissions/:submissionId", async (req, res) => {
  try {
    const { submissionId } = req.params;

    const { data: submissionRow, error: submissionError } = await supabase
      .from("submissions")
      .select(
        `
        id,
        assignment_id,
        assignment:assignments (
          id,
          course_id
        )
      `
      )
      .eq("id", submissionId)
      .maybeSingle();

    if (submissionError) {
      throw submissionError;
    }

    if (!submissionRow) {
      return res.status(404).json({ message: "Submission not found" });
    }

    const { error: ownershipError } = await ensureCourseOwnership(
      req.user.id,
      submissionRow.assignment?.course_id
    );
    if (ownershipError) {
      return res.status(ownershipError.status).json({ message: ownershipError.message });
    }

    const { error: deleteError } = await supabase
      .from("submissions")
      .delete()
      .eq("id", submissionId);

    if (deleteError) {
      throw deleteError;
    }

    const io = req.app.get("io");
    io?.emit(`submission-delete-${submissionRow.assignment_id}`, { id: submissionId });

    res.json({ message: "Submission deleted" });
  } catch (error) {
    console.error("Delete submission error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/timetable", async (req, res) => {
  try {
    // First check if table exists by trying a simple query
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
      .eq("teacher_id", req.user.id)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) {
      if (error.code === "42P01") {
        console.warn("teacher_schedule_slots table not found, returning empty array");
        return res.json([]);
      }
      // If foreign key error, try without the join
      if (error.code === "42703" || error.message?.includes("does not exist") || error.message?.includes("column")) {
        console.warn("Error with course join, trying without join:", error.message);
        const { data: simpleData, error: simpleError } = await supabase
          .from("teacher_schedule_slots")
          .select("id, teacher_id, course_id, day_of_week, start_time, end_time, location, notes, created_at, updated_at")
          .eq("teacher_id", req.user.id)
          .order("day_of_week", { ascending: true })
          .order("start_time", { ascending: true });

        if (simpleError) {
          if (simpleError.code === "42P01") {
            return res.json([]);
          }
          throw simpleError;
        }

        return res.json((simpleData ?? []).map((row) => ({
          id: row.id,
          teacherId: row.teacher_id,
          courseId: row.course_id,
          course: row.course_id ? { id: row.course_id, name: null } : null,
          dayOfWeek: row.day_of_week,
          startTime: row.start_time,
          endTime: row.end_time,
          location: row.location ?? null,
          notes: row.notes ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })));
      }
      throw error;
    }

    res.json((data ?? []).map((row) => ({
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
    })));
  } catch (error) {
    console.error("Get teacher timetable error:", error);
    // Return empty array instead of 500 error to prevent frontend crash
    res.json([]);
  }
});

router.post("/timetable/request-change", async (req, res) => {
  try {
    const { slotId, requestedDayOfWeek, requestedStartTime, requestedEndTime, reason } = req.body;

    console.log("[Request Schedule Change] Request received:", {
      slotId,
      requestedDayOfWeek,
      requestedStartTime,
      requestedEndTime,
      reason: reason?.substring(0, 50),
      teacherId: req.user?.id,
      teacherName: req.user?.name,
    });

    if (!slotId || !reason) {
      return res.status(400).json({ message: "Slot ID and reason are required" });
    }

    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // Verify the slot belongs to this teacher
    const { data: slotRow, error: slotError } = await supabase
      .from("teacher_schedule_slots")
      .select("id, teacher_id, course_id, day_of_week, start_time, end_time")
      .eq("id", slotId)
      .eq("teacher_id", req.user.id)
      .maybeSingle();

    if (slotError) {
      console.error("[Request Schedule Change] Error fetching slot:", slotError);
      throw slotError;
    }

    if (!slotRow) {
      return res.status(404).json({ message: "Slot not found or you don't have permission" });
    }

    // Get teacher name if not in req.user
    let teacherName = req.user.name;
    if (!teacherName) {
      const { data: teacherData, error: teacherError } = await supabase
        .from("users")
        .select("name")
        .eq("id", req.user.id)
        .maybeSingle();
      
      if (!teacherError && teacherData) {
        teacherName = teacherData.name || "Teacher";
      } else {
        teacherName = "Teacher";
      }
    }

    // Create schedule change request in the new dedicated table
    const requestData = {
      slot_id: slotId,
      teacher_id: req.user.id,
      course_id: slotRow.course_id || null,
      current_day_of_week: slotRow.day_of_week,
      current_start_time: slotRow.start_time,
      current_end_time: slotRow.end_time,
      requested_day_of_week: requestedDayOfWeek || null,
      requested_start_time: requestedStartTime || null,
      requested_end_time: requestedEndTime || null,
      reason: reason,
      status: 'pending',
    };

    console.log("[Request Schedule Change] Creating schedule change request:", requestData);

    const { data: createdRequest, error: createError } = await supabase
      .from("schedule_change_requests")
      .insert(requestData)
      .select("id, status, created_at")
      .single();

    if (createError) {
      console.error("[Request Schedule Change] Error creating request:", createError);
      throw createError;
    }

    console.log("[Request Schedule Change] Successfully created request:", createdRequest);

    const io = req.app.get("io");
    if (io) {
      io.emit("admin-notifications-refresh", {
        type: "schedule_change_request",
        teacherId: req.user.id,
      });
    }

    res.json({
      message: "Schedule change request submitted successfully",
    });
  } catch (error) {
    console.error("[Request Schedule Change] Unexpected error:", error);
    console.error("[Request Schedule Change] Error details:", {
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

router.get("/announcements", async (req, res) => {
  try {
    // Get teacher's courses
    const { data: courseRows, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", req.user.id);

    if (coursesError) {
      throw coursesError;
    }

    const courseIds = (courseRows ?? []).map((row) => row.id);

    let query = supabase
      .from("announcements")
      .select(
        `
        id,
        title,
        body,
        pinned,
        course_id,
        author_id,
        created_at,
        updated_at,
        course:course_id (
          id,
          name
        )
      `
      )
      .eq("author_id", req.user.id)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false });

    const { data, error } = await query;

    if (error) {
      if (error.code === "42P01") {
        return res.json([]);
      }
      throw error;
    }

    res.json(
      (data ?? []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        title: row.title,
        body: row.body,
        pinned: row.pinned ?? false,
        courseId: row.course_id,
        course: row.course
          ? {
              id: row.course.id,
              name: row.course.name,
            }
          : null,
        updatedAt: row.updated_at,
      }))
    );
  } catch (error) {
    console.error("Get teacher announcements error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/announcements", async (req, res) => {
  try {
    console.log("Announcement creation request:", {
      body: req.body,
      user: req.user?.id,
      userRole: req.user?.role,
    });

    const { title, body, courseIds, pinned } = req.body;

    if (!title || !body) {
      console.error("Missing required fields:", { title: !!title, body: !!body });
      return res.status(400).json({ message: "Title and body are required" });
    }

    if (!req.user || !req.user.id) {
      console.error("User not authenticated");
      return res.status(401).json({ message: "User not authenticated" });
    }

    // If courseIds provided, verify teacher owns those courses
    if (courseIds && Array.isArray(courseIds) && courseIds.length > 0) {
      const { data: courseRows, error: coursesError } = await supabase
        .from("courses")
        .select("id")
        .eq("teacher_id", req.user.id)
        .in("id", courseIds);

      if (coursesError) {
        throw coursesError;
      }

      const validCourseIds = (courseRows ?? []).map((row) => row.id);
      const invalidIds = courseIds.filter((id) => !validCourseIds.includes(id));

      if (invalidIds.length > 0) {
        return res.status(403).json({
          message: `You don't have permission to create announcements for some courses`,
        });
      }
    }

    // Create announcements for each course (or one general if no courses)
    const announcementsToCreate = courseIds && courseIds.length > 0
      ? courseIds.map((courseId) => ({
          title,
          body,
          course_id: courseId,
          author_id: req.user.id, // Use author_id to match database schema
          pinned: pinned ?? false,
        }))
      : [
          {
            title,
            body,
            course_id: null,
            author_id: req.user.id, // Use author_id to match database schema
            pinned: pinned ?? false,
          },
        ];

    const { data: insertedRows, error: insertError } = await supabase
      .from("announcements")
      .insert(announcementsToCreate)
      .select(
        `
        id,
        title,
        body,
        pinned,
        course_id,
        author_id,
        created_at,
        updated_at,
        course:course_id (
          id,
          name
        )
      `
      );

    if (insertError) {
      console.error("Announcement insert error details:", {
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        fullError: JSON.stringify(insertError, null, 2),
      });
      
      if (insertError.code === "42P01") {
        return res.status(500).json({
          message: "Announcements table not found. Please run the SQL migration to create announcements table.",
        });
      }
      
      // Provide more specific error message
      return res.status(500).json({
        message: "Failed to create announcement",
        error: insertError.message || "Unknown error",
        code: insertError.code,
        details: insertError.details,
        hint: insertError.hint,
      });
    }

    const io = req.app.get("io");
    // Emit to all students (they'll filter by course enrollment)
    io?.emit("announcement-created", {
      announcements: insertedRows ?? [],
    });

    // Also create notifications for students
    const courseIdsForNotifications = courseIds && courseIds.length > 0 ? courseIds : [null];
    
    for (const courseId of courseIdsForNotifications) {
      let studentIds = [];

      if (courseId) {
        const { data: enrollmentRows } = await supabase
          .from("course_students")
          .select("student_id")
          .eq("course_id", courseId);

        studentIds = (enrollmentRows ?? []).map((row) => row.student_id);
      } else {
        // General announcement - get all students
        const { data: studentRows } = await supabase
          .from("users")
          .select("id")
          .eq("role", "student")
          .eq("status", "Active");

        studentIds = (studentRows ?? []).map((row) => row.id);
      }

      if (studentIds.length > 0) {
        const notifications = studentIds.map((studentId) => ({
          recipient_id: studentId,
          title: title,
          message: body,
          type: "announcement",
          sender_id: req.user.id,
          channels: ["in_app"],
          audience_scope: courseId ? "course" : "global",
          course_id: courseId,
        }));

        const { data: insertedNotifications, error: notificationError } = await supabase
          .from("notifications")
          .insert(notifications)
          .select("id, recipient_id, title");

        if (notificationError) {
          // Log but don't fail the announcement creation
          console.error("[CREATE ANNOUNCEMENT] ❌ Failed to create notifications:", notificationError);
          console.error("[CREATE ANNOUNCEMENT] Error details:", {
            message: notificationError.message,
            code: notificationError.code,
            details: notificationError.details,
            hint: notificationError.hint
          });
        } else {
          console.log(`[CREATE ANNOUNCEMENT] ✅ Created ${insertedNotifications?.length || 0} notification(s) for ${studentIds.length} student(s)`);
          if (insertedNotifications && insertedNotifications.length > 0) {
            console.log(`[CREATE ANNOUNCEMENT] Sample notification:`, insertedNotifications[0]);
          }
        }
      }
    }

    res.status(201).json({
      message: "Announcement(s) created successfully",
      announcements: (insertedRows ?? []).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        title: row.title,
        body: row.body,
        pinned: row.pinned ?? false,
        courseId: row.course_id,
        course: row.course
          ? {
              id: row.course.id,
              name: row.course.name,
            }
          : null,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    const errorDetails = {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
      details: error.details,
      hint: error.hint,
    };
    
    console.error("Create announcement error:", errorDetails);
    console.error("Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    res.status(500).json({ 
      message: "Server error",
      error: error.message || "Unknown error",
      code: error.code,
      details: {
        error: error.message,
        code: error.code,
        hint: error.hint,
        details: error.details,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      },
    });
  }
});

router.put("/announcements/:announcementId", async (req, res) => {
  try {
    const { announcementId } = req.params;
    const { title, body, pinned } = req.body;

    // Verify ownership
    const { data: existing, error: existingError } = await supabase
      .from("announcements")
      .select("id, author_id, course_id")
      .eq("id", announcementId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    if (existing.author_id !== req.user.id) {
      return res.status(403).json({ message: "You can only edit your own announcements" });
    }

    const updates = {};
    if (title !== undefined) updates.title = title;
    if (body !== undefined) updates.body = body;
    if (pinned !== undefined) updates.pinned = pinned ?? false;

    const { data: updatedRow, error: updateError } = await supabase
      .from("announcements")
      .update(updates)
      .eq("id", announcementId)
      .select(
        `
        id,
        title,
        body,
        pinned,
        course_id,
        author_id,
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

    const io = req.app.get("io");
    io?.emit("announcement-updated", {
      announcement: updatedRow,
    });

    res.json({
      message: "Announcement updated",
      announcement: {
        id: updatedRow.id,
        createdAt: updatedRow.created_at,
        title: updatedRow.title,
        body: updatedRow.body,
        pinned: updatedRow.pinned ?? false,
        courseId: updatedRow.course_id,
        course: updatedRow.course
          ? {
              id: updatedRow.course.id,
              name: updatedRow.course.name,
            }
          : null,
        updatedAt: updatedRow.updated_at,
      },
    });
  } catch (error) {
    console.error("Update announcement error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.delete("/announcements/:announcementId", async (req, res) => {
  try {
    const { announcementId } = req.params;

    // Verify ownership
    const { data: existing, error: existingError } = await supabase
      .from("announcements")
      .select("id, author_id")
      .eq("id", announcementId)
      .maybeSingle();

    if (existingError) {
      throw existingError;
    }

    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    if (existing.author_id !== req.user.id) {
      return res.status(403).json({ message: "You can only delete your own announcements" });
    }

    const { error: deleteError } = await supabase
      .from("announcements")
      .delete()
      .eq("id", announcementId);

    if (deleteError) {
      throw deleteError;
    }

    const io = req.app.get("io");
    io?.emit("announcement-deleted", {
      announcementId: announcementId,
    });

    res.json({ message: "Announcement deleted" });
  } catch (error) {
    console.error("Delete announcement error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/settings/profile", async (req, res) => {
  try {
    const { data: teacherRow, error } = await supabase
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
        updated_at
      `
      )
      .eq("id", req.user.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!teacherRow) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    res.json({
      profile: {
        id: teacherRow.id,
        name: teacherRow.name,
        email: teacherRow.email,
        role: teacherRow.role,
        status: teacherRow.status,
        avatarUrl: teacherRow.metadata?.avatarUrl || null,
        phone: teacherRow.metadata?.phone || null,
        department: teacherRow.metadata?.department || null,
        location: teacherRow.metadata?.location || null,
        metadata: teacherRow.metadata || {},
        createdAt: teacherRow.created_at,
        updatedAt: teacherRow.updated_at,
      },
    });
  } catch (error) {
    console.error("Get teacher profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/settings/profile", async (req, res) => {
  try {
    const { name, email, password, metadata } = req.body;

    const { data: existingRow, error: fetchError } = await supabase
      .from("users")
      .select("id, email, metadata")
      .eq("id", req.user.id)
      .maybeSingle();

    if (fetchError) {
      throw fetchError;
    }

    if (!existingRow) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    const updates = {};

    if (name) {
      updates.name = name;
    }

    if (email && email !== existingRow.email) {
      const normalizedEmail = email.toLowerCase();
      const { data: existingEmail, error: emailError } = await supabase
        .from("users")
        .select("id")
        .eq("email", normalizedEmail)
        .maybeSingle();

      if (emailError) {
        throw emailError;
      }

      if (existingEmail && existingEmail.id !== existingRow.id) {
        return res.status(400).json({ message: "Email already in use" });
      }

      updates.email = normalizedEmail;
    }

    if (password) {
      const bcrypt = (await import("bcryptjs")).default;
      updates.password_hash = await bcrypt.hash(password, 10);
    }

    if (metadata && typeof metadata === "object") {
      updates.metadata = {
        ...(existingRow.metadata ?? {}),
        ...metadata,
      };
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "No valid fields provided for update" });
    }

    const { data: updatedRow, error: updateError } = await supabase
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
        updated_at
      `
      )
      .single();

    if (updateError) {
      throw updateError;
    }

    res.json({
      message: "Profile updated successfully",
      profile: {
        id: updatedRow.id,
        name: updatedRow.name,
        email: updatedRow.email,
        role: updatedRow.role,
        status: updatedRow.status,
        avatarUrl: updatedRow.metadata?.avatarUrl || null,
        phone: updatedRow.metadata?.phone || null,
        department: updatedRow.metadata?.department || null,
        location: updatedRow.metadata?.location || null,
        metadata: updatedRow.metadata || {},
        createdAt: updatedRow.created_at,
        updatedAt: updatedRow.updated_at,
      },
    });
  } catch (error) {
    console.error("Update teacher profile error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/attendance/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;

    const { error } = await ensureCourseOwnership(req.user.id, courseId);
    if (error) {
      return res.status(error.status).json({ message: error.message });
    }

    const { data, error: fetchError } = await supabase
      .from("attendance")
      .select(
        `
        id,
        course_id,
        session_date,
        created_at,
        updated_at,
        records:attendance_records (
          student_id,
          status
        )
      `
      )
      .eq("course_id", courseId)
      .order("session_date", { ascending: false });

    if (fetchError) {
      throw fetchError;
    }

    res.json((data ?? []).map(mapAttendance));
  } catch (error) {
    console.error("Get attendance error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /teacher/assignment-file-url
// Generate a signed URL for accessing a student's assignment file (for teachers)
router.get("/assignment-file-url", protect, async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ message: "File path is required" });
    }

    // Verify that the teacher has access to this file
    // Extract student ID from file path (format: studentId/timestamp-random.ext)
    const pathParts = filePath.split('/');
    if (pathParts.length < 2) {
      return res.status(400).json({ message: "Invalid file path format" });
    }

    const fileStudentId = pathParts[0];

    // Check if the teacher teaches any course that this student is enrolled in
    // First, get all courses taught by this teacher
    const { data: teacherCourses, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", req.user.id);

    if (coursesError) {
      throw coursesError;
    }

    if (!teacherCourses || teacherCourses.length === 0) {
      return res.status(403).json({ message: "Access denied. You don't teach any courses." });
    }

    const courseIds = teacherCourses.map(c => c.id);

    // Check if the student is enrolled in any of the teacher's courses
    const { data: enrollment, error: enrollmentError } = await supabase
      .from("course_students")
      .select("course_id")
      .eq("student_id", fileStudentId)
      .in("course_id", courseIds)
      .limit(1)
      .maybeSingle();

    if (enrollmentError) {
      throw enrollmentError;
    }

    if (!enrollment) {
      return res.status(403).json({ 
        message: "Access denied. This student is not enrolled in any of your courses." 
      });
    }

    // Generate signed URL (valid for 1 hour)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from('student-submissions')
      .createSignedUrl(filePath, 3600);

    if (signedUrlError) {
      console.error('[TEACHER ASSIGNMENT FILE URL] Signed URL generation error:', signedUrlError);
      return res.status(500).json({ 
        message: 'Failed to generate file access URL',
        error: signedUrlError.message 
      });
    }

    console.log(`[TEACHER ASSIGNMENT FILE URL] Generated signed URL for file: ${filePath}`);

    res.json({
      signedUrl: signedUrlData.signedUrl,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(), // 1 hour from now
    });
  } catch (error) {
    console.error('[TEACHER ASSIGNMENT FILE URL] Error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// GET /teacher/course-outline/:courseId - Get course outline by course ID
router.get("/course-outline/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    
    if (!courseId) {
      return res.status(400).json({ message: "Course ID is required" });
    }
    
    console.log(`[Teacher Course Outline] Fetching outline for course ${courseId} by teacher ${req.user.id}`);
    
    // Verify course ownership
    const { course, error: courseError } = await ensureCourseOwnership(req.user.id, courseId);
    if (courseError) {
      return res.status(courseError.status).json({ message: courseError.message });
    }
    
    // Get course outline
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
          console.log(`[Teacher Course Outline] course_outlines table not found. Run create_course_outlines_table.sql in Supabase.`);
          return res.status(404).json({ message: "Course outline table not found" });
        } else {
          console.error("[Teacher Course Outline] Error fetching course outline:", outlineError);
          return res.status(500).json({ 
            message: "Error fetching course outline",
            error: process.env.NODE_ENV === 'development' ? outlineError.message : undefined
          });
        }
      } else if (outlineData) {
        outline = outlineData;
        console.log(`[Teacher Course Outline] ✅ Found outline for course ${courseId}`);
      } else {
        console.log(`[Teacher Course Outline] ℹ️ No outline found for course ${courseId}`);
        return res.status(404).json({ message: "Course outline not found" });
      }
    } catch (error) {
      console.error("[Teacher Course Outline] Exception while fetching course outline:", error);
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
    console.error("Get teacher course outline error:", error);
    res.status(500).json({ 
      message: "Server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /teacher/recent-activities - Get recent activities for teacher
router.get("/recent-activities", async (req, res) => {
  try {
    const teacherId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;

    console.log(`[Teacher Recent Activities] Fetching activities for teacher ${teacherId}`);

    const activities = [];

    // Get teacher's course IDs
    const { data: teacherCourses, error: coursesError } = await supabase
      .from("courses")
      .select("id")
      .eq("teacher_id", teacherId);

    if (coursesError) {
      console.error("[Teacher Recent Activities] Error fetching courses:", coursesError);
      throw coursesError;
    }

    const courseIds = (teacherCourses || []).map(c => c.id);

    if (courseIds.length === 0) {
      return res.json({ activities: [] });
    }

    // 1. Get assignment IDs for teacher's courses first
    const { data: assignments, error: assignmentsError } = await supabase
      .from("assignments")
      .select("id")
      .in("course_id", courseIds);

    const assignmentIds = (assignments || []).map(a => a.id);

    // 2. Get recent submissions from students in teacher's courses
    let recentSubmissions = [];
    if (assignmentIds.length > 0) {
      const { data: submissionsData, error: submissionsError } = await supabase
        .from("submissions")
        .select(`
          id,
          assignment_id,
          student_id,
          status,
          created_at,
          updated_at,
          assignment:assignments!submissions_assignment_id_fkey (
            id,
            title,
            course_id,
            course:courses!assignments_course_id_fkey (
              id,
              name
            )
          ),
          student:users!submissions_student_id_fkey (
            id,
            name,
            email
          )
        `)
        .in("assignment_id", assignmentIds)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!submissionsError && submissionsData) {
        recentSubmissions = submissionsData;
      }
    }

    if (recentSubmissions.length > 0) {
      recentSubmissions.forEach((submission) => {
        if (submission.assignment && submission.assignment.course && submission.student) {
          activities.push({
            id: `submission-${submission.id}`,
            type: "submission",
            title: `${submission.student.name} submitted "${submission.assignment.title}"`,
            description: `Course: ${submission.assignment.course.name}`,
            user: {
              id: submission.student.id,
              name: submission.student.name,
              email: submission.student.email,
            },
            metadata: {
              submissionId: submission.id,
              assignmentId: submission.assignment_id,
              assignmentTitle: submission.assignment.title,
              courseId: submission.assignment.course_id,
              courseName: submission.assignment.course.name,
              status: submission.status,
            },
            timestamp: submission.created_at,
          });
        }
      });
    }

    // 3. Get recent attendance records for teacher's courses
    const { data: attendanceSessions, error: attendanceError } = await supabase
      .from("attendance")
      .select(`
        id,
        course_id,
        session_date,
        created_at,
        course:courses!attendance_course_id_fkey (
          id,
          name
        )
      `)
      .in("course_id", courseIds)
      .order("created_at", { ascending: false })
      .limit(10);

    if (!attendanceError && attendanceSessions) {
      attendanceSessions.forEach((session) => {
        if (session.course) {
          activities.push({
            id: `attendance-${session.id}`,
            type: "attendance",
            title: `Attendance session created for ${session.course.name}`,
            description: `Date: ${new Date(session.session_date).toLocaleDateString()}`,
            user: null,
            metadata: {
              attendanceId: session.id,
              courseId: session.course_id,
              courseName: session.course.name,
              sessionDate: session.session_date,
            },
            timestamp: session.created_at,
          });
        }
      });
    }

    // 4. Get admin announcements/updates for teachers
    // Get announcements where author is admin and either course_id is null (general) or in teacher's courses
    const { data: announcements, error: announcementsError } = await supabase
      .from("announcements")
      .select(`
        id,
        title,
        body,
        course_id,
        created_at,
        updated_at,
        author:users!announcements_author_id_fkey (
          id,
          name,
          email,
          role
        )
      `)
      .or(`course_id.is.null,course_id.in.(${courseIds.join(',')})`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!announcementsError && announcements) {
      announcements.forEach((announcement) => {
        // Include announcements from admins (admin updates) or announcements for teacher's courses
        if (announcement.author && (
          announcement.author.role === 'admin' || 
          announcement.author.role === 'super_admin' || 
          announcement.author.role === 'co_admin' ||
          (announcement.course_id && courseIds.includes(announcement.course_id))
        )) {
          activities.push({
            id: `announcement-${announcement.id}`,
            type: "announcement",
            title: announcement.title,
            description: announcement.body?.substring(0, 100) || "",
            user: {
              id: announcement.author.id,
              name: announcement.author.name,
              email: announcement.author.email,
            },
            metadata: {
              announcementId: announcement.id,
              body: announcement.body,
              courseId: announcement.course_id,
            },
            timestamp: announcement.created_at,
          });
        }
      });
    }

    // 5. Get notifications for this teacher
    const { data: notifications, error: notificationsError } = await supabase
      .from("notifications")
      .select(`
        id,
        title,
        message,
        sender_id,
        created_at,
        course_id,
        sender:users!notifications_sender_id_fkey (
          id,
          name,
          email,
          role
        )
      `)
      .eq("recipient_id", teacherId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!notificationsError && notifications && notifications.length > 0) {
      notifications.forEach((notification) => {
        activities.push({
          id: `notification-${notification.id}`,
          type: "notification",
          title: notification.title || "Notification",
          description: notification.message || "",
          user: notification.sender ? {
            id: notification.sender.id,
            name: notification.sender.name,
            email: notification.sender.email,
          } : null,
          metadata: {
            notificationId: notification.id,
            courseId: notification.course_id,
          },
          timestamp: notification.created_at,
        });
      });
    }

    // Sort all activities by timestamp (newest first)
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Return top N activities
    const topActivities = activities.slice(0, limit);

    console.log(`[Teacher Recent Activities] Returning ${topActivities.length} activities`);

    res.json({
      activities: topActivities,
      total: activities.length,
    });
  } catch (error) {
    console.error("[Teacher Recent Activities] Error:", error);
    res.status(500).json({ 
      message: "Server error",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export default router;

