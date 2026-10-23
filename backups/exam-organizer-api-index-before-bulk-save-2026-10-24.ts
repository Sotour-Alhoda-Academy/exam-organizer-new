import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://somaiamoomen-ui.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

const asText = (v: unknown, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const allowedRiwaya = (v: unknown) => v === "qalun" ? "qalun" : "hafs";
const activeStatuses = ["registered", "confirmed", "needs_review"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin");
    if (origin && origin !== "https://somaiamoomen-ui.github.io") {
      return new Response("Origin not allowed", { status: 403 });
    }
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const origin = req.headers.get("origin");
  if (origin && origin !== "https://somaiamoomen-ui.github.io") {
    return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "SERVER_CONFIGURATION_ERROR" }, 500);

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const action = asText(body.action, 60);
  const clientIp = asText(req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown", 100);
  const ipBytes = new TextEncoder().encode(clientIp);
  const ipDigest = await crypto.subtle.digest("SHA-256", ipBytes);
  const ipHash = Array.from(new Uint8Array(ipDigest)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const rateLimit = async (name: string, limit: number, windowSeconds = 60) => {
    const { data, error } = await db.rpc("consume_public_rate_limit", {
      p_ip_hash: ipHash,
      p_action: name,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    return !error && data === true;
  };

  const getPublishedExam = async (examId?: string) => {
    let query = db.from("exams")
      .select("id,title,exam_date,status,registration_state,default_duration_minutes,instructions")
      .eq("status", "published");
    if (examId) query = query.eq("id", examId);
    else query = query.order("exam_date", { ascending: false, nullsFirst: false }).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data;
  };

  try {
    if (action === "public_exams") {
      if (!await rateLimit("public_exams", 60)) return json({ error: "RATE_LIMITED" }, 429);
      const { data, error } = await db.from("exams").select("id,title,exam_date,status,registration_state,default_duration_minutes,instructions").eq("status", "published").order("exam_date", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
      if (error) throw error;
      return json({ exams: data || [] });
    }

    if (action === "public_exam") {
      if (!await rateLimit("public_exam", 60)) return json({ error: "RATE_LIMITED" }, 429);
      const exam = await getPublishedExam(asText(body.exam_id, 80) || undefined);
      if (!exam) return json({ exam: null, teachers: [] });
      const { data: settings, error } = await db.from("exam_teacher_settings")
        .select("teacher_id,is_available,accepts_qalun,start_time,end_time,capacity,capacity_override,duration_minutes,teachers:teachers!exam_teacher_settings_teacher_id_fkey(id,full_name,is_active)")
        .eq("exam_id", exam.id)
        .eq("is_available", true);
      if (error) throw error;
      const settingsRows = settings || [];
      const teacherIds = settingsRows.filter((x: any) => x.teachers?.is_active).map((x: any) => x.teacher_id);
      const { data: registrations, error: regError } = await db.from("registrations")
        .select("assigned_teacher_id")
        .eq("exam_id", exam.id)
        .in("status", activeStatuses)
        .in("assigned_teacher_id", teacherIds.length ? teacherIds : ["00000000-0000-0000-0000-000000000000"]);
      if (regError) throw regError;
      const counts = new Map<string, number>();
      for (const row of registrations || []) counts.set(row.assigned_teacher_id, (counts.get(row.assigned_teacher_id) || 0) + 1);
      const teachers = settingsRows.filter((x: any) => x.teachers?.is_active).map((x: any) => {
        const duration = x.duration_minutes || exam.default_duration_minutes || 5;
        const calculated = x.start_time && x.end_time
          ? Math.max(0, Math.floor((new Date("1970-01-01T" + x.end_time + "Z").getTime() - new Date("1970-01-01T" + x.start_time + "Z").getTime()) / 60000 / duration))
          : null;
        const capacity = x.capacity_override ?? x.capacity ?? calculated;
        const registered = counts.get(x.teacher_id) || 0;
        return {
          id: x.teacher_id,
          acceptsQalun: x.accepts_qalun,
          startTime: x.start_time,
          endTime: x.end_time,
          capacity,
          registered,
          remaining: capacity === null ? null : Math.max(0, capacity - registered),
          durationMinutes: duration,
        };
      });
      return json({ exam, teachers });
    }

    if (action === "lookup_student") {
      if (!await rateLimit("lookup_student", 20)) return json({ error: "RATE_LIMITED" }, 429);
      const studentNumber = asText(body.student_number, 80);
      if (!studentNumber) return json({ error: "STUDENT_NUMBER_REQUIRED" }, 400);
      const exam = await getPublishedExam(asText(body.exam_id, 80) || undefined);
      if (!exam) return json({ error: "NO_PUBLISHED_EXAM" }, 404);
      if (exam.registration_state !== "open") {
        return json({ error: exam.registration_state === "paused" ? "REGISTRATION_PAUSED" : "REGISTRATION_CLOSED", exam });
      }
      const { data: students, error } = await db.from("exam_students")
        .select("id,student_number,student_name,riwaya,is_eligible")
        .eq("exam_id", exam.id).eq("student_number", studentNumber).eq("is_eligible", true)
        .order("student_name");
      if (error) throw error;
      if (!students?.length) return json({ error: "STUDENT_NOT_FOUND" }, 404);
      const ids = students.map((student: any) => student.id);
      const { data: existingRows, error: existingError } = await db.from("registrations")
        .select("exam_student_id,status,assigned_teacher_id").eq("exam_id", exam.id)
        .in("exam_student_id", ids).in("status", activeStatuses);
      if (existingError) throw existingError;
      const registeredIds = new Set((existingRows || []).map((row: any) => row.exam_student_id));
      return json({
        exam: { id: exam.id, title: exam.title, registrationState: exam.registration_state },
        students: students.map((student: any) => {
          const existing = (existingRows || []).find((row: any) => row.exam_student_id === student.id);
          return {
            id: student.id, name: student.student_name, riwaya: student.riwaya,
            alreadyRegistered: registeredIds.has(student.id),
            currentTeacherId: existing?.assigned_teacher_id || null,
          };
        }),
      });
    }

    if (action === "register_student") {
      if (!await rateLimit("register_student", 8)) return json({ error: "RATE_LIMITED" }, 429);
      const examId = asText(body.exam_id, 80);
      const studentId = asText(body.student_id, 80);
      const teacherId = asText(body.teacher_id, 80);
      if (!examId || !studentId || !teacherId) return json({ error: "MISSING_REQUIRED_FIELDS" }, 400);
      const { data, error } = await db.rpc("register_exam_student_by_id", {
        p_exam_id: examId,
        p_exam_student_id: studentId,
        p_teacher_id: teacherId,
      });
      if (error) {
        const msg = error.message || "";
        const known: Record<string, string> = {
          EXAM_NOT_AVAILABLE: "EXAM_NOT_AVAILABLE",
          REGISTRATION_CLOSED: "REGISTRATION_CLOSED",
          STUDENT_NOT_FOUND: "STUDENT_NOT_FOUND",
          ALREADY_REGISTERED: "ALREADY_REGISTERED",
          TEACHER_NOT_AVAILABLE: "TEACHER_NOT_AVAILABLE",
          TEACHER_DOES_NOT_ACCEPT_QALUN: "TEACHER_DOES_NOT_ACCEPT_QALUN",
          TEACHER_CAPACITY_REACHED: "TEACHER_CAPACITY_REACHED",
        };
        const code = Object.keys(known).find((key) => msg.includes(key));
        return json({ error: code ? known[code] : "REGISTRATION_FAILED" }, code ? 409 : 500);
      }
      return json({ ok: true, registration: data });
    }

    if (action === "report_issue") {
      if (!await rateLimit("report_issue", 5)) return json({ error: "RATE_LIMITED" }, 429);
      const examId = asText(body.exam_id, 80);
      const studentNumber = asText(body.student_number, 80);
      const studentName = asText(body.student_name, 120);
      const message = asText(body.message, 1000);
      const category = asText(body.category, 40);
      if (!examId || !message) return json({ error: "MISSING_REQUIRED_FIELDS" }, 400);
      const exam = await getPublishedExam(examId);
      if (!exam) return json({ error: "EXAM_NOT_AVAILABLE" }, 404);
      const safeCategory = ["lookup", "registration", "teacher_choice", "schedule", "other"].includes(category) ? category : "other";
      const { error } = await db.from("registration_issues").insert({
        exam_id: examId,
        student_number: studentNumber || null,
        student_name: studentName || null,
        message,
        category: safeCategory,
      });
      if (error) throw error;
      return json({ ok: true });
    }

    // All admin actions require a valid Supabase Auth access token and an active admin record.
    if (!action.startsWith("admin_")) return json({ error: "UNKNOWN_ACTION" }, 400);
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token || token === serviceKey) return json({ error: "ADMIN_AUTH_REQUIRED" }, 401);
    const { data: authData, error: authError } = await db.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "ADMIN_AUTH_INVALID" }, 401);
    const { data: admin, error: adminError } = await db.from("admin_users")
      .select("user_id,role,is_active")
      .eq("user_id", authData.user.id)
      .eq("is_active", true)
      .maybeSingle();
    if (adminError || !admin) return json({ error: "ADMIN_ACCESS_DENIED" }, 403);

    const actorId = authData.user.id;
    const audit = async (auditAction: string, entityType: string, entityId: string | null, details: Record<string, unknown> = {}) => {
      await db.from("exam_audit_log").insert({
        actor_user_id: actorId,
        action: auditAction,
        entity_type: entityType,
        entity_id: entityId,
        details,
      });
    };

    if (action === "admin_list_exams") {
      const { data, error } = await db.from("exams").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json({ exams: data || [] });
    }

    if (action === "admin_get_workspace") {
      const examId = asText(body.exam_id, 80);
      if (!examId) return json({ error: "EXAM_ID_REQUIRED" }, 400);
      const { data, error } = await db.from("exam_workspace_settings").select("*").eq("exam_id", examId).maybeSingle();
      if (error) throw error;
      return json({ workspace: data || null });
    }

    if (action === "admin_save_workspace") {
      const examId = asText(body.exam_id, 80);
      if (!examId) return json({ error: "EXAM_ID_REQUIRED" }, 400);
      const duration = Number(body.list_duration_minutes) === 10 ? 10 : 5;
      const patch = {
        exam_id: examId,
        students_input: typeof body.students_input === "string" ? body.students_input.slice(0, 200000) : "",
        schedule_input: typeof body.schedule_input === "string" ? body.schedule_input.slice(0, 100000) : "",
        list_duration_minutes: duration,
        generated_lists: Array.isArray(body.generated_lists) ? body.generated_lists.slice(0, 100) : [],
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await db.from("exam_workspace_settings").upsert(patch, { onConflict: "exam_id" }).select("*").single();
      if (error) throw error;
      await audit("exam_workspace_saved", "exam_workspace_settings", examId, { student_text_length: patch.students_input.length, schedule_text_length: patch.schedule_input.length, generated_lists: patch.generated_lists.length });
      return json({ workspace: data });
    }

    if (action === "admin_list_teachers") {
      const { data, error } = await db.from("teachers").select("*").order("sort_order").order("full_name");
      if (error) throw error;
      return json({ teachers: data || [] });
    }

    if (action === "admin_dashboard") {
      const examId = asText(body.exam_id, 80);
      if (!examId) return json({ error: "EXAM_ID_REQUIRED" }, 400);
      const { data: exam, error: examError } = await db.from("exams").select("*").eq("id", examId).maybeSingle();
      if (examError) throw examError;
      if (!exam) return json({ error: "EXAM_NOT_FOUND" }, 404);
      const [studentsResult, registrationsResult, teachersResult, issuesResult] = await Promise.all([
        db.from("exam_students").select("id,student_number,student_name,riwaya,is_eligible", { count: "exact" }).eq("exam_id", examId),
        db.from("registrations").select("id,status,assigned_teacher_id,exam_student_id,student:exam_students!registrations_exam_student_id_fkey(student_number,student_name,riwaya)", { count: "exact" }).eq("exam_id", examId),
        db.from("exam_teacher_settings").select("teacher_id,is_available,accepts_qalun,capacity,capacity_override,duration_minutes,start_time,end_time,teachers:teachers!exam_teacher_settings_teacher_id_fkey(id,full_name,is_active)").eq("exam_id", examId),
        db.from("registration_issues").select("*", { count: "exact" }).eq("exam_id", examId).order("reported_at", { ascending: false }).limit(100),
      ]);
      for (const result of [studentsResult, registrationsResult, teachersResult, issuesResult]) if (result.error) throw result.error;
      return json({
        exam,
        students: studentsResult.data || [],
        registrations: registrationsResult.data || [],
        teacherSettings: teachersResult.data || [],
        issues: issuesResult.data || [],
        counts: {
          students: studentsResult.count || 0,
          registrations: registrationsResult.count || 0,
          issues: issuesResult.count || 0,
          registered: (registrationsResult.data || []).filter((x: any) => activeStatuses.includes(x.status)).length,
        },
      });
    }

    if (action === "admin_save_exam") {
      const examId = asText(body.exam_id, 80);
      const title = asText(body.title, 200);
      if (!title) return json({ error: "TITLE_REQUIRED" }, 400);
      const patch = {
        title,
        exam_date: asText(body.exam_date, 20) || null,
        status: ["draft", "published", "completed", "archived"].includes(asText(body.status, 30)) ? asText(body.status, 30) : "draft",
        registration_state: ["closed", "open", "paused"].includes(asText(body.registration_state, 30)) ? asText(body.registration_state, 30) : "closed",
        default_duration_minutes: Number(body.default_duration_minutes) === 10 ? 10 : 5,
        instructions: asText(body.instructions, 2000) || null,
        updated_at: new Date().toISOString(),
        ...(examId ? {} : { created_by: actorId }),
      };
      const result = examId
        ? await db.from("exams").update(patch).eq("id", examId).select("*").single()
        : await db.from("exams").insert(patch).select("*").single();
      if (result.error) throw result.error;
      await audit(examId ? "exam_updated" : "exam_created", "exam", result.data.id, { title });
      return json({ exam: result.data });
    }

    if (action === "admin_delete_exam") {
      const examId = asText(body.exam_id, 80);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(examId)) {
        return json({ error: "EXAM_ID_REQUIRED" }, 400);
      }
      const { data, error } = await db.rpc("admin_delete_exam_complete", { p_exam_id: examId });
      if (error) {
        if (String(error.message || "").includes("EXAM_NOT_FOUND")) return json({ error: "EXAM_NOT_FOUND" }, 404);
        throw error;
      }
      return json({ result: data });
    }

    if (action === "admin_set_registration_state") {
      const examId = asText(body.exam_id, 80);
      const state = asText(body.registration_state, 30);
      if (!examId || !["closed", "open", "paused"].includes(state)) return json({ error: "INVALID_FIELDS" }, 400);
      const { data, error } = await db.from("exams").update({ registration_state: state, updated_at: new Date().toISOString() }).eq("id", examId).select("*").single();
      if (error) throw error;
      await audit("registration_state_changed", "exam", examId, { registration_state: state });
      return json({ exam: data });
    }

    if (action === "admin_save_teacher") {
      const teacherId = asText(body.teacher_id, 80);
      const fullName = asText(body.full_name, 160);
      if (!fullName) return json({ error: "TEACHER_NAME_REQUIRED" }, 400);
      const patch = {
        full_name: fullName,
        phone: asText(body.phone, 80) || null,
        whatsapp: asText(body.whatsapp, 120) || null,
        telegram: asText(body.telegram, 120) || null,
        messenger: asText(body.messenger, 120) || null,
        notes: asText(body.notes, 1000) || null,
        is_active: body.is_active !== false,
        sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
        updated_at: new Date().toISOString(),
      };
      const result = teacherId
        ? await db.from("teachers").update(patch).eq("id", teacherId).select("*").single()
        : await db.from("teachers").insert(patch).select("*").single();
      if (result.error) throw result.error;
      await audit(teacherId ? "teacher_updated" : "teacher_created", "teacher", result.data.id, { full_name: fullName });
      return json({ teacher: result.data });
    }

    if (action === "admin_delete_teacher") {
      const teacherId = asText(body.teacher_id, 80);
      if (!teacherId) return json({ error: "TEACHER_ID_REQUIRED" }, 400);
      const { data: teacher, error: teacherError } = await db.from("teachers")
        .select("id,full_name,is_active").eq("id", teacherId).maybeSingle();
      if (teacherError) throw teacherError;
      if (!teacher) return json({ error: "TEACHER_NOT_FOUND" }, 404);

      const [settingsResult, preferredResult, assignedResult] = await Promise.all([
        db.from("exam_teacher_settings").select("id").eq("teacher_id", teacherId).limit(1),
        db.from("registrations").select("id").eq("preferred_teacher_id", teacherId).limit(1),
        db.from("registrations").select("id").eq("assigned_teacher_id", teacherId).limit(1),
      ]);
      for (const result of [settingsResult, preferredResult, assignedResult]) if (result.error) throw result.error;
      const hasHistory = (settingsResult.data || []).length > 0 ||
        (preferredResult.data || []).length > 0 || (assignedResult.data || []).length > 0;

      if (hasHistory) {
        const { data, error } = await db.from("teachers")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", teacherId).select("*").single();
        if (error) throw error;
        await audit("teacher_deactivated", "teacher", teacherId, { full_name: teacher.full_name, reason: "linked_history" });
        return json({ deleted: false, teacher: data });
      }

      const { data, error } = await db.from("teachers").delete().eq("id", teacherId).select("id,full_name").single();
      if (error) throw error;
      await audit("teacher_deleted", "teacher", teacherId, { full_name: teacher.full_name });
      return json({ deleted: true, teacher: data });
    }

    if (action === "admin_save_teacher_settings") {
      const examId = asText(body.exam_id, 80);
      const teacherId = asText(body.teacher_id, 80);
      if (!examId || !teacherId) return json({ error: "MISSING_REQUIRED_FIELDS" }, 400);
      const nullableInt = (v: unknown) => v === null || v === "" || v === undefined ? null : Math.max(0, Math.floor(Number(v)));
      const patch = {
        exam_id: examId,
        teacher_id: teacherId,
        is_available: body.is_available !== false,
        accepts_qalun: body.accepts_qalun === true,
        start_time: asText(body.start_time, 20) || null,
        end_time: asText(body.end_time, 20) || null,
        capacity: nullableInt(body.capacity),
        capacity_override: nullableInt(body.capacity_override),
        capacity_override_reason: asText(body.capacity_override_reason, 300) || null,
        duration_minutes: Number(body.duration_minutes) === 10 ? 10 : (Number(body.duration_minutes) === 5 ? 5 : null),
        notes: asText(body.notes, 1000) || null,
        updated_at: new Date().toISOString(),
      };
      if (patch.capacity_override !== null && !patch.capacity_override_reason) return json({ error: "CAPACITY_OVERRIDE_REASON_REQUIRED" }, 400);
      const { data, error } = await db.from("exam_teacher_settings").upsert(patch, { onConflict: "exam_id,teacher_id" }).select("*").single();
      if (error) throw error;
      await audit("teacher_settings_updated", "exam_teacher_settings", data.id, { exam_id: examId, teacher_id: teacherId });
      return json({ teacherSettings: data });
    }

    if (action === "admin_import_students") {
      const examId = asText(body.exam_id, 80);
      const students = Array.isArray(body.students) ? body.students.slice(0, 5000) : [];
      if (!examId || !students.length) return json({ error: "EXAM_ID_AND_STUDENTS_REQUIRED" }, 400);
      const rows = students.map((x: any) => ({
        exam_id: examId, student_number: asText(x?.student_number, 80),
        student_name: asText(x?.student_name, 160), riwaya: allowedRiwaya(x?.riwaya),
        is_eligible: x?.is_eligible !== false, notes: asText(x?.notes, 500) || null,
      })).filter((x: any) => x.student_number && x.student_name);
      if (!rows.length) return json({ error: "NO_VALID_STUDENTS" }, 400);
      const normalize = (v: string) => v.normalize("NFKC").replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي").replace(/[ًٌٍَُِّْـ]/g,"").replace(/\s+/g," ").trim().toLowerCase();
      const uniqueRows: any[] = [];
      const incomingKeys = new Set<string>();
      for (const row of rows) {
        const key = String(row.student_number) + "|" + normalize(row.student_name);
        if (!incomingKeys.has(key)) { incomingKeys.add(key); uniqueRows.push(row); }
      }
      const { data: oldRows, error: oldError } = await db.from("exam_students").select("id,student_number,student_name").eq("exam_id", examId);
      if (oldError) throw oldError;
      const old = oldRows || [];
      const usedIds = new Set<string>();
      const saved: any[] = [];
      for (const row of uniqueRows) {
        const match = old.find((x: any) => !usedIds.has(x.id) &&
          String(x.student_number) === row.student_number && normalize(String(x.student_name)) === normalize(row.student_name));
        let result;
        if (match) {
          const { data, error } = await db.from("exam_students").update({...row}).eq("id", match.id)
            .select("id,student_number,student_name,riwaya,is_eligible").single();
          if (error) throw error; result = data;
        } else {
          const { data, error } = await db.from("exam_students").insert(row)
            .select("id,student_number,student_name,riwaya,is_eligible").single();
          if (error) throw error; result = data;
        }
        usedIds.add(result.id); saved.push(result);
      }
      const omittedIds = old.filter((x: any) => !usedIds.has(x.id)).map((x: any) => x.id);
      if (omittedIds.length) {
        const { error } = await db.from("exam_students").update({is_eligible:false}).in("id", omittedIds);
        if (error) throw error;
      }
      await audit("students_imported", "exam_students", examId, { received: students.length, saved: saved.length });
      return json({ ok: true, saved: saved.length, students: saved });
    }

    if (action === "admin_update_registration") {
      const registrationId = asText(body.registration_id, 80);
      if (!registrationId) return json({ error: "REGISTRATION_ID_REQUIRED" }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), changed_by: actorId };
      if (["registered", "confirmed", "needs_review", "cancelled", "completed"].includes(asText(body.status, 30))) {
        patch.status = asText(body.status, 30);
        if (patch.status === "confirmed") patch.confirmed_at = new Date().toISOString();
      }
      if (typeof body.assigned_teacher_id === "string") patch.assigned_teacher_id = body.assigned_teacher_id || null;
      if (typeof body.notes === "string") patch.notes = asText(body.notes, 1000) || null;
      const { data, error } = await db.from("registrations").update(patch).eq("id", registrationId).select("*").single();
      if (error) throw error;
      await audit("registration_updated", "registration", registrationId, patch);
      return json({ registration: data });
    }

    if (action === "admin_update_issue") {
      const issueId = asText(body.issue_id, 80);
      const status = asText(body.status, 30);
      if (!issueId || !["open", "in_progress", "resolved", "dismissed"].includes(status)) return json({ error: "INVALID_FIELDS" }, 400);
      const patch = {
        status,
        admin_note: asText(body.admin_note, 1000) || null,
        resolved_at: status === "resolved" ? new Date().toISOString() : null,
        resolved_by: status === "resolved" ? actorId : null,
      };
      const { data, error } = await db.from("registration_issues").update(patch).eq("id", issueId).select("*").single();
      if (error) throw error;
      await audit("issue_updated", "registration_issue", issueId, { status });
      return json({ issue: data });
    }

    return json({ error: "UNKNOWN_ADMIN_ACTION" }, 400);
  } catch (error) {
    console.error("exam-organizer-api error", error);
    return json({ error: "INTERNAL_SERVER_ERROR" }, 500);
  }
});
