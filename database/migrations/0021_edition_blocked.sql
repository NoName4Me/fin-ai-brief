ALTER TABLE edition_runs DROP CONSTRAINT edition_runs_status_check;
ALTER TABLE edition_runs ADD CONSTRAINT edition_runs_status_check
  CHECK (status IN ('unscheduled','skipped','error','published','ready','blocked'));
