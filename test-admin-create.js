/**
 * Quick test script to diagnose admin creation issues
 * Run with: node test-admin-create.js
 */

import dotenv from 'dotenv';
import { supabase } from './config/supabaseClient.js';
import bcrypt from 'bcryptjs';

dotenv.config();

const testAdminCreation = async () => {
  console.log('Testing admin creation...\n');
  
  // Test 1: Check Supabase connection
  console.log('1. Testing Supabase connection...');
  try {
    const { data, error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      console.error('❌ Supabase connection error:', error);
      return;
    }
    console.log('✅ Supabase connected');
  } catch (err) {
    console.error('❌ Supabase connection failed:', err.message);
    return;
  }
  
  // Test 2: Check if users table exists and has required columns
  console.log('\n2. Testing users table structure...');
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, password_hash, status, metadata')
      .limit(1);
    
    if (error) {
      console.error('❌ Users table query error:', error);
      console.error('   Code:', error.code);
      console.error('   Message:', error.message);
      return;
    }
    console.log('✅ Users table accessible');
  } catch (err) {
    console.error('❌ Users table check failed:', err.message);
    return;
  }
  
  // Test 3: Test password hashing
  console.log('\n3. Testing password hashing...');
  try {
    const testPassword = 'testpassword123';
    const hashed = await bcrypt.hash(testPassword, 10);
    const match = await bcrypt.compare(testPassword, hashed);
    if (match) {
      console.log('✅ Password hashing works');
    } else {
      console.error('❌ Password hashing verification failed');
    }
  } catch (err) {
    console.error('❌ Password hashing failed:', err.message);
    return;
  }
  
  // Test 4: Check for existing email
  console.log('\n4. Testing email uniqueness check...');
  try {
    const testEmail = 'test@example.com';
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('email', testEmail)
      .maybeSingle();
    
    if (error) {
      console.error('❌ Email check error:', error);
      return;
    }
    console.log('✅ Email uniqueness check works');
  } catch (err) {
    console.error('❌ Email check failed:', err.message);
    return;
  }
  
  // Test 5: Try to insert a test admin (will rollback)
  console.log('\n5. Testing admin insertion (dry run)...');
  try {
    const testData = {
      name: 'Test Admin',
      email: `test-${Date.now()}@example.com`,
      role: 'co_admin',
      status: 'active',
      password_hash: await bcrypt.hash('testpass123', 10),
      metadata: {}
    };
    
    const { data, error } = await supabase
      .from('users')
      .insert(testData)
      .select('id')
      .single();
    
    if (error) {
      console.error('❌ Insert test error:', error);
      console.error('   Code:', error.code);
      console.error('   Message:', error.message);
      console.error('   Details:', error.details);
      console.error('   Hint:', error.hint);
      return;
    }
    
    // Clean up test data
    if (data?.id) {
      await supabase.from('users').delete().eq('id', data.id);
      console.log('✅ Admin insertion works (test data cleaned up)');
    }
  } catch (err) {
    console.error('❌ Insert test failed:', err.message);
    console.error('   Stack:', err.stack);
    return;
  }
  
  console.log('\n✅ All tests passed!');
};

testAdminCreation().catch(console.error);

