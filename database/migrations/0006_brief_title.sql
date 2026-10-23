UPDATE briefs SET published=published-'leadEventId', draft=draft-'leadEventId' WHERE published ? 'leadEventId' OR draft ? 'leadEventId';
