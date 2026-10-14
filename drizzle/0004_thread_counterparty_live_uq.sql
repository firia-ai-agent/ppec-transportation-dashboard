-- One live thread per (site, counterparty, channel): the key messaging/sim-provider.getOrCreateThread
-- looks up. Partial, so a CLOSED thread can still be reopened in a new one, and NULL counterparty_token
-- rows (unknown senders) never conflict.
-- Pre-existing data: nothing seeds ops.conversation_thread, and before this index threads were only ever
-- created one-per-key by getOrCreateThread, so an existing database can violate this only if the race it
-- fixes already happened there. If CREATE UNIQUE INDEX fails, close the duplicate live threads for that
-- counterparty (state='CLOSED') before re-running; no message rows move.
CREATE UNIQUE INDEX "thread_counterparty_live_uq" ON "ops"."conversation_thread" USING btree ("site_id","counterparty_token","channel") WHERE state <> 'CLOSED';
