-- migration: no-transaction
-- migration: code 0112_ask_multi_question_rows.ts sha256:b585786110a98d8a9cae67542a54228b1f4d76cb25d1aeab5a6cbe05ceb743f8
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM asks WHERE kind = 'question' AND payload ? 'question')
    OR EXISTS (SELECT 1 FROM asks WHERE status = 'open' AND opened_at IS NULL) THEN
    RAISE EXCEPTION 'ask rewrite left a one-question ask';
  END IF;
END
$$;
