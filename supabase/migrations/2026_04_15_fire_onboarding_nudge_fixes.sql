-- 2026-04-15: Fix three bugs in the morning nudge (fire_onboarding_nudge):
--   1. Gap too small — raise activity gate from 3h to 20h so users active
--      yesterday evening are not nudged this morning.
--   2. Names shown in English — add hebrewize_name() helper (ported from the
--      JS NAME_MAP in index.inlined.ts:1965) and COALESCE preferred_name
--      over the auto-captured context.name.
--   3. Reminder time dropped — select send_at in the reminder loop and
--      render it as "— {hebrew_day_label} ב-H:MM".
--
-- Plan: C:\Users\yarond\.claude\plans\curious-purring-abelson.md
-- Verified root cause by reading pg_get_functiondef and production state
-- on 2026-04-15; the morning nudge fired at 09:00 IST to Daniel (972523955056)
-- who had been active yesterday evening.

-- ============================================================================
-- Helper 1 — Hebrew-ize a name (first token only, compound-name aware)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.hebrewize_name(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed    text;
  tok1       text;
  tok2       text;
  two_tokens text;
  lower1     text;
BEGIN
  IF input IS NULL OR TRIM(input) = '' THEN RETURN NULL; END IF;
  trimmed    := TRIM(input);
  tok1       := split_part(trimmed, ' ', 1);
  tok2       := split_part(trimmed, ' ', 2);
  two_tokens := CASE WHEN tok2 = '' THEN tok1 ELSE tok1 || ' ' || tok2 END;

  -- Known Hebrew compound first names — keep both tokens intact.
  -- Extend as new families join; one source of truth for this list.
  IF tok2 <> '' AND two_tokens IN (
    -- בת-
    'בת אור','בת אל','בת שבע','בת חן','בת יה','בת עמי','בת שלום','בת ציון',
    -- בן-
    'בן אל','בן ציון','בן אור','בן חור','בן ארי','בן חיים','בן שלום','בן עמי',
    -- שי-/שיר-
    'שי לי','שי אור','שיר לי','שיר אל',
    -- טל-/אור-/בר-
    'טל אור','טל אל','טל יה','אור לי','אור אל','אור חן',
    'בר אל','בר לב','בר חן','בר און','בר יה',
    -- Misc
    'דן אל','אל עד','עין גל','מאור לי'
  ) THEN
    RETURN two_tokens;
  END IF;

  -- Otherwise: first token only, translated if in the English name map.
  -- Map ported from index.inlined.ts:1965-1982 (keep in sync).
  lower1 := LOWER(tok1);
  RETURN CASE lower1
    WHEN 'yaron'    THEN 'ירון'
    WHEN 'adi'      THEN 'עדי'
    WHEN 'noa'      THEN 'נועה'
    WHEN 'noah'     THEN 'נועה'
    WHEN 'lior'     THEN 'ליאור'
    WHEN 'roie'     THEN 'רועי'
    WHEN 'roi'      THEN 'רועי'
    WHEN 'dan'      THEN 'דן'
    WHEN 'daniel'   THEN 'דניאל'
    WHEN 'omer'     THEN 'עומר'
    WHEN 'omar'     THEN 'עומר'
    WHEN 'gal'      THEN 'גל'
    WHEN 'ido'      THEN 'עידו'
    WHEN 'nir'      THEN 'ניר'
    WHEN 'tal'      THEN 'טל'
    WHEN 'ori'      THEN 'אורי'
    WHEN 'amit'     THEN 'עמית'
    WHEN 'yael'     THEN 'יעל'
    WHEN 'maya'     THEN 'מאיה'
    WHEN 'shira'    THEN 'שירה'
    WHEN 'tamar'    THEN 'תמר'
    WHEN 'michal'   THEN 'מיכל'
    WHEN 'mor'      THEN 'מור'
    WHEN 'neta'     THEN 'נטע'
    WHEN 'lina'     THEN 'לינה'
    WHEN 'mia'      THEN 'מיה'
    WHEN 'yuval'    THEN 'יובל'
    WHEN 'eyal'     THEN 'אייל'
    WHEN 'ofek'     THEN 'אופק'
    WHEN 'ohev'     THEN 'אוהב'
    WHEN 'oriane'   THEN 'אוריין'
    WHEN 'orian'    THEN 'אוריין'
    WHEN 'lin'      THEN 'לין'
    WHEN 'gur'      THEN 'גור'
    WHEN 'liona'    THEN 'ליאונה'
    WHEN 'maayan'   THEN 'מעיין'
    WHEN 'amor'     THEN 'אמור'
    WHEN 'shanee'   THEN 'שני'
    WHEN 'shani'    THEN 'שני'
    WHEN 'shachar'  THEN 'שחר'
    WHEN 'sahar'    THEN 'סהר'
    WHEN 'saar'     THEN 'סער'
    WHEN 'sa''ar'   THEN 'סער'
    WHEN 'chen'     THEN 'חן'
    WHEN 'lee'      THEN 'לי'
    WHEN 'li'       THEN 'לי'
    WHEN 'lia'      THEN 'ליאה'
    WHEN 'noy'      THEN 'נוי'
    WHEN 'ron'      THEN 'רון'
    WHEN 'ran'      THEN 'רן'
    WHEN 'alon'     THEN 'אלון'
    WHEN 'eran'     THEN 'ערן'
    WHEN 'oren'     THEN 'אורן'
    WHEN 'noga'     THEN 'נוגה'
    WHEN 'shay'     THEN 'שי'
    WHEN 'shai'     THEN 'שי'
    WHEN 'rotem'    THEN 'רותם'
    WHEN 'liron'    THEN 'לירון'
    WHEN 'lihi'     THEN 'ליהי'
    WHEN 'sapir'    THEN 'ספיר'
    WHEN 'inbar'    THEN 'ענבר'
    WHEN 'hadar'    THEN 'הדר'
    WHEN 'agam'     THEN 'אגם'
    WHEN 'alma'     THEN 'אלמה'
    WHEN 'itay'     THEN 'איתי'
    WHEN 'itai'     THEN 'איתי'
    WHEN 'ilan'     THEN 'אילן'
    WHEN 'amir'     THEN 'אמיר'
    WHEN 'tomer'    THEN 'תומר'
    WHEN 'dor'      THEN 'דור'
    WHEN 'guy'      THEN 'גיא'
    WHEN 'matan'    THEN 'מתן'
    ELSE tok1  -- fallback: original first token as-is
               -- (handles Hebrew input like "חביב" or unknown English names)
  END;
END;
$$;


-- ============================================================================
-- Helper 2 — Hebrew day label relative to today (Asia/Jerusalem)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.hebrew_day_label(ts timestamptz)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  d_local     date;
  today_local date;
  days_ahead  int;
  dow         int;
  day_name    text;
BEGIN
  d_local     := (ts AT TIME ZONE 'Asia/Jerusalem')::date;
  today_local := (now() AT TIME ZONE 'Asia/Jerusalem')::date;
  days_ahead  := d_local - today_local;

  IF days_ahead = 0 THEN RETURN 'היום'; END IF;
  IF days_ahead = 1 THEN RETURN 'מחר';  END IF;

  dow := extract(dow from ts AT TIME ZONE 'Asia/Jerusalem'); -- 0=Sun … 6=Sat
  day_name := CASE dow
    WHEN 0 THEN 'ראשון'
    WHEN 1 THEN 'שני'
    WHEN 2 THEN 'שלישי'
    WHEN 3 THEN 'רביעי'
    WHEN 4 THEN 'חמישי'
    WHEN 5 THEN 'שישי'
    WHEN 6 THEN 'שבת'
  END;

  IF days_ahead >= 7 THEN
    -- Next week (or later)
    IF dow = 6 THEN
      RETURN day_name || ' הבאה';               -- "שבת הבאה" (feminine)
    ELSE
      RETURN 'יום ' || day_name || ' הבא';       -- "יום שני הבא" (masculine)
    END IF;
  ELSE
    -- This week (2–6 days ahead)
    IF dow = 6 THEN
      RETURN day_name;                           -- "שבת" (no leading "יום ")
    ELSE
      RETURN 'יום ' || day_name;                 -- "יום שני"
    END IF;
  END IF;
END;
$$;


-- ============================================================================
-- Main — fire_onboarding_nudge (full replacement)
--   Changes from prior version:
--   (1) activity gate: 3h → 20h
--   (2) greeting name: COALESCE(preferred_name, name), hebrewize only the
--       auto-captured name (trust user's own spelling for preferred_name)
--   (3) reminder loop: also select send_at, append " — {day} ב-H:MM"
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fire_onboarding_nudge(p_nudge_number integer, p_greeting text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_count integer := 0;
  v_row record;
  v_message text;
  v_name text;
  v_tried text[];
  v_request_id bigint;
  v_items_text text;
  v_has_items boolean;
  v_dow integer;
  v_hour integer;
  v_min_gap interval;
  v_task record;
  v_shop record;
  v_event record;
  v_reminder record;
  v_total_items integer;
  v_max_per_kind constant integer := 5;
BEGIN
  v_dow  := extract(dow  from now() at time zone 'Asia/Jerusalem');
  v_hour := extract(hour from now() at time zone 'Asia/Jerusalem');

  IF v_dow = 5 AND v_hour NOT BETWEEN 7 AND 11 THEN RETURN 0; END IF;
  IF v_dow = 6 AND v_hour NOT BETWEEN 19 AND 21 THEN RETURN 0; END IF;
  IF v_dow NOT IN (5, 6) AND v_hour NOT BETWEEN 7 AND 21 THEN RETURN 0; END IF;

  IF p_nudge_number <= 2 THEN
    v_min_gap := interval '44 hours';
  ELSE
    v_min_gap := interval '116 hours';
  END IF;

  FOR v_row IN
    SELECT id, phone, household_id, demo_items, tried_capabilities, context,
           context->>'name'           as user_name,
           context->>'preferred_name' as preferred_name
    FROM onboarding_conversations
    WHERE nudge_count = p_nudge_number - 1
      AND state IN ('sleeping', 'nudging')
      AND message_count >= 1
      AND (last_nudge_at IS NULL OR last_nudge_at < now() - v_min_gap)
      AND updated_at < now() - interval '20 hours'   -- was '3 hours' (bug fix 2026-04-15)
    LIMIT 10
  LOOP
    -- Greeting name: prefer user's own choice (trust spelling), else hebrewize the WA-captured name.
    IF v_row.preferred_name IS NOT NULL AND TRIM(v_row.preferred_name) <> '' THEN
      v_name := NULLIF(TRIM(v_row.preferred_name), '');
    ELSE
      v_name := NULLIF(TRIM(regexp_replace(COALESCE(v_row.user_name, ''), '[^א-תA-Za-z0-9 ''\-]', '', 'g')), '');
      v_name := hebrewize_name(v_name);
    END IF;

    v_tried := COALESCE(v_row.tried_capabilities, '{}');

    IF p_nudge_number = 1 THEN
      v_items_text := '';
      v_has_items := false;
      v_total_items := 0;

      -- Read from REAL tables (filtered: open tasks, unbought shopping, future events, unsent + future reminders)
      IF v_row.household_id IS NOT NULL THEN
        -- Open tasks
        FOR v_task IN
          SELECT title FROM tasks
          WHERE household_id = v_row.household_id AND done = false
          ORDER BY created_at ASC LIMIT v_max_per_kind
        LOOP
          v_items_text := v_items_text || '☐ ' || v_task.title || E'\n';
          v_has_items := true;
          v_total_items := v_total_items + 1;
        END LOOP;

        -- Open shopping
        FOR v_shop IN
          SELECT name FROM shopping_items
          WHERE household_id = v_row.household_id AND got = false
          ORDER BY created_at ASC LIMIT v_max_per_kind
        LOOP
          v_items_text := v_items_text || '🛒 ' || v_shop.name || E'\n';
          v_has_items := true;
          v_total_items := v_total_items + 1;
        END LOOP;

        -- Future events (today onwards)
        FOR v_event IN
          SELECT title, scheduled_for FROM events
          WHERE household_id = v_row.household_id
            AND scheduled_for >= now()
          ORDER BY scheduled_for ASC LIMIT v_max_per_kind
        LOOP
          v_items_text := v_items_text || '📅 ' || v_event.title || E'\n';
          v_has_items := true;
          v_total_items := v_total_items + 1;
        END LOOP;

        -- Future reminders only (sent=false AND send_at >= now)
        -- Bug fix 2026-04-15: also render send_at as " — {day} ב-H:MM".
        FOR v_reminder IN
          SELECT message_text, send_at FROM reminder_queue
          WHERE household_id = v_row.household_id
            AND sent = false
            AND send_at >= now()
          ORDER BY send_at ASC LIMIT v_max_per_kind
        LOOP
          v_items_text := v_items_text
            || '⏰ ' || v_reminder.message_text
            || ' — ' || hebrew_day_label(v_reminder.send_at)
            || ' ב-' || to_char(v_reminder.send_at AT TIME ZONE 'Asia/Jerusalem', 'FMHH24:MI')
            || E'\n';
          v_has_items := true;
          v_total_items := v_total_items + 1;
        END LOOP;
      END IF;

      -- Build the message
      IF v_has_items THEN
        IF v_name IS NOT NULL THEN
          v_message := p_greeting || ' ' || v_name || '!' || E'\n\n';
        ELSE
          v_message := p_greeting || E'\n\n';
        END IF;
        v_message := v_message || 'הנה מה שיש להיום:' || E'\n' || v_items_text;
        v_message := v_message || E'\nצריכים להוסיף משהו?';
      ELSE
        IF v_name IS NOT NULL THEN
          v_message := p_greeting || ' ' || v_name || '!' || E'\n\n';
        ELSE
          v_message := p_greeting || E'\n\n';
        END IF;
        v_message := v_message ||
          'אם יש משהו להביא מהסופר או מטלה שצריך לזכור, שלחו לי ואני שומרת.' || E'\n\n' ||
          'אני כאן כל היום 😊';
      END IF;
    ELSIF p_nudge_number = 2 THEN
      IF v_name IS NOT NULL THEN
        v_message := p_greeting || ' ' || v_name || '!' || E'\n\n';
      ELSE
        v_message := p_greeting || E'\n\n';
      END IF;
      IF NOT 'reminder' = ANY(v_tried) THEN
        v_message := v_message || 'אגב, ידעתם שאם כותבים לי "תזכירי לי ב-5 להוציא בשר מהמקפיא" אני באמת מזכירה? ⏰' || E'\n\n' || 'אם צריך משהו, אני כאן';
      ELSIF NOT 'task' = ANY(v_tried) THEN
        v_message := v_message || 'חוץ מקניות, אני גם מסדרת מטלות בבית.' || E'\n' || '"צריך לפרוק מדיח" ואני שומרת ומזכירה ✅';
      ELSE
        v_message := v_message || 'אני יכולה גם לסדר תורות בבית, מי שוטף כלים, מי מוציא זבל...' || E'\n' || 'רוצים לנסות? 😊';
      END IF;
    ELSIF p_nudge_number = 3 THEN
      IF v_name IS NOT NULL THEN
        v_message := p_greeting || ' ' || v_name || E'\n\n';
      ELSE
        v_message := p_greeting || E'\n\n';
      END IF;
      v_message := v_message ||
        'אני לא רוצה להטריד, אבל חשוב לי שתדעו,' || E'\n' ||
        'כבר עשרות אנשים משתמשים בי כל יום לקניות, מטלות ותזכורות.' || E'\n\n' ||
        'אם תרצו לנסות, אני כאן.' || E'\n' ||
        'ואם לא, אין שום בעיה 😊 לא אכתוב יותר.';
    END IF;

    SELECT net.http_post(
      url := 'https://gate.whapi.cloud/messages/text',
      headers := '{"Authorization": "Bearer aEkZMZijZ1FRCVfuCjJpXflZOsxoat6m", "Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object(
        'to', v_row.phone || '@s.whatsapp.net',
        'body', v_message
      )
    ) INTO v_request_id;

    UPDATE onboarding_conversations
    SET nudge_count = p_nudge_number,
        last_nudge_at = now(),
        state = CASE WHEN p_nudge_number >= 3 THEN 'dormant' ELSE 'nudging' END,
        updated_at = now()
    WHERE id = v_row.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;
