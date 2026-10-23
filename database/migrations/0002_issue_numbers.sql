ALTER TABLE briefs ADD COLUMN issue_number integer CHECK (issue_number > 0);
WITH numbered AS (
  SELECT id,row_number() OVER (PARTITION BY kind,extract(year FROM period_date) ORDER BY period_date,id)::integer AS number
  FROM briefs WHERE published IS NOT NULL
)
UPDATE briefs SET issue_number=numbered.number FROM numbered WHERE briefs.id=numbered.id;
CREATE UNIQUE INDEX briefs_issue_number_unique ON briefs(kind,(extract(year FROM period_date)),issue_number);
