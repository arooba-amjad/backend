/**
 * Helper script to list all available courses
 * Usage: node scripts/listCourses.js
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

async function listCourses() {
  try {
    console.log('\n🔍 Fetching courses...\n');
    
    const { data: courses, error } = await supabase
      .from('courses')
      .select('id, name, description, teacher_id, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Error fetching courses:', error);
      return;
    }

    if (!courses || courses.length === 0) {
      console.log('⚠️  No courses found in database.');
      console.log('   Create a course first using the admin panel.');
      return;
    }

    console.log(`✅ Found ${courses.length} course(s):\n`);
    
    courses.forEach((course, index) => {
      console.log(`${index + 1}. ${course.name}`);
      console.log(`   ID: ${course.id}`);
      if (course.description) {
        console.log(`   Description: ${course.description.substring(0, 60)}${course.description.length > 60 ? '...' : ''}`);
      }
      console.log('');
    });

    console.log('\n💡 To enroll a student, use:');
    console.log(`   node scripts/enrollStudent.js <studentEmail> <courseId>`);
    console.log(`\n   Example:`);
    console.log(`   node scripts/enrollStudent.js student@portal.com ${courses[0]?.id || '<course-id>'}`);
    
  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }
}

listCourses()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

