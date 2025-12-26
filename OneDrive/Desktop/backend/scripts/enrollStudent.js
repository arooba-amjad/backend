/**
 * Helper script to enroll a student in a course
 * Usage: node scripts/enrollStudent.js <studentEmail> <courseId>
 * 
 * Example: node scripts/enrollStudent.js student@portal.com <course-uuid>
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function enrollStudent(studentEmail, courseId) {
  try {
    console.log(`\n🔍 Looking up student: ${studentEmail}`);
    
    // Find student by email
    const { data: student, error: studentError } = await supabase
      .from('users')
      .select('id, name, email, status, course_id')
      .eq('email', studentEmail.toLowerCase())
      .eq('role', 'student')
      .maybeSingle();

    if (studentError) {
      console.error('❌ Error finding student:', studentError);
      return;
    }

    if (!student) {
      console.error(`❌ Student not found: ${studentEmail}`);
      return;
    }

    console.log(`✅ Found student: ${student.name} (${student.id})`);
    console.log(`   Status: ${student.status || 'null'}`);
    console.log(`   Current course_id: ${student.course_id || 'none'}`);

    // Check if course exists
    console.log(`\n🔍 Looking up course: ${courseId}`);
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('id, name, teacher_id')
      .eq('id', courseId)
      .maybeSingle();

    if (courseError) {
      console.error('❌ Error finding course:', courseError);
      return;
    }

    if (!course) {
      console.error(`❌ Course not found: ${courseId}`);
      return;
    }

    console.log(`✅ Found course: ${course.name} (${course.id})`);

    // Check if enrollment already exists
    const { data: existingEnrollment, error: checkError } = await supabase
      .from('course_students')
      .select('course_id, student_id')
      .eq('course_id', courseId)
      .eq('student_id', student.id)
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking enrollment:', checkError);
      // Continue anyway - might be a schema issue
    }

    if (existingEnrollment) {
      console.log(`⚠️  Enrollment already exists!`);
      console.log(`   Course ID: ${existingEnrollment.course_id}`);
      console.log(`   Student ID: ${existingEnrollment.student_id}`);
      return;
    }

    // Create enrollment
    console.log(`\n📝 Creating enrollment...`);
    const { data: enrollment, error: enrollmentError } = await supabase
      .from('course_students')
      .insert({
        course_id: courseId,
        student_id: student.id,
        student_name: student.name,
        student_email: student.email,
        course_name: course.name,
      })
      .select('course_id, student_id')
      .single();

    if (enrollmentError) {
      console.error('❌ Error creating enrollment:', enrollmentError);
      return;
    }

    console.log(`✅ Enrollment created successfully!`);
    console.log(`   Course ID: ${enrollment.course_id}`);
    console.log(`   Student ID: ${enrollment.student_id}`);

    // Update user's course_id
    console.log(`\n📝 Updating user's course_id...`);
    const { error: updateError } = await supabase
      .from('users')
      .update({ course_id: courseId })
      .eq('id', student.id);

    if (updateError) {
      console.error('⚠️  Error updating user course_id:', updateError);
    } else {
      console.log(`✅ User course_id updated`);
    }

    console.log(`\n✅ Student enrolled successfully!`);
    console.log(`   Student: ${student.name} (${student.email})`);
    console.log(`   Course: ${course.name}`);
    
  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }
}

// Get command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node scripts/enrollStudent.js <studentEmail> <courseId>');
  console.log('\nExample:');
  console.log('  node scripts/enrollStudent.js student@portal.com <course-uuid>');
  console.log('\nTo find available courses, run:');
  console.log('  node scripts/listCourses.js');
  process.exit(1);
}

const [studentEmail, courseId] = args;

enrollStudent(studentEmail, courseId)
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

