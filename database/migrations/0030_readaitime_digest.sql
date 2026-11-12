UPDATE sources
SET url = 'https://www.readaitime.com/digests',
    format = 'html',
    etag = NULL,
    last_error = NULL,
    next_fetch_at = NULL,
    verification_status = 'pending',
    verification_note = '',
    verified_at = NULL
WHERE url IN ('https://www.readaitime.com/rss.xml', 'https://readaitime.com/rss.xml')
  AND format = 'rss';
