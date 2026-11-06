-- migration: no-transaction
-- migration: code 0112_ask_multi_question_rows.ts sha256:30857f6b44d24223689674960a94b8cb3a66b8e6de4c3c33453be652b01fb906
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM asks WHERE kind = 'question' AND payload ? 'question')
    OR EXISTS (SELECT 1 FROM asks WHERE status = 'open' AND opened_at IS NULL) THEN
    RAISE EXCEPTION 'ask rewrite left a one-question ask';
  END IF;
END
$$;
