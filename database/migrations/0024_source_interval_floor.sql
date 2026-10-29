UPDATE sources SET interval_minutes=greatest(interval_minutes,60),
 min_interval_minutes=greatest(min_interval_minutes,60),
 max_interval_minutes=greatest(max_interval_minutes,60)
WHERE interval_minutes<60 OR min_interval_minutes<60 OR max_interval_minutes<60;
