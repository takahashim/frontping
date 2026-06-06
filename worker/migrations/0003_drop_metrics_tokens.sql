-- per-app メトリクストークン認証を廃止（閲覧はダッシュボードの GitHub セッションに一本化）。
-- §9.4 のトークン経路はコードから撤去済み。未使用テーブルを削除する。
DROP TABLE IF EXISTS metrics_tokens;
