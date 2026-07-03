-- Prevent two cases from sharing an access code. Indexed on upper(access_code)
-- rather than the raw column, matching the case-insensitive lookup used by
-- services/simulation_repository.fetch_case_snapshot (upper(access_code) = upper(?)) --
-- otherwise "abc1" and "ABC1" could both be inserted and still collide there.
--
-- Partial index (WHERE access_code IS NOT NULL AND access_code != ''): a case
-- with no access code yet is a normal, expected state (e.g. still being
-- authored) and the frontend sends '' rather than omitting the field, so many
-- such cases must be allowed to coexist without colliding on "no code".
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_access_code_upper
  ON cases (upper(access_code))
  WHERE access_code IS NOT NULL AND access_code != '';
