DROP INDEX sources_url_unique;
CREATE UNIQUE INDEX sources_url_unique ON sources(url) WHERE format <> 'wechat';
