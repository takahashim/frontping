import { BaseHtml } from "./Layout";
import noticeCss from "./notices.css";

// ダッシュボード本体とは別系統の案内ページ（認証前/ログアウト後）。chrome は付けない。
// GitHub OAuth の設定が中途半端なときの案内（値は出さず、未設定の名前だけ）。
const ConfigErrorPage = (props: { missing: string[] }) => (
  <BaseHtml title="frontping" css={noticeCss}>
    <h1>⚠️ GitHub ログインの設定が未完了です</h1>
    <p>ダッシュボードの認証に必要な secret が一部不足しています。設定を確認してください。</p>
    <p>
      未設定:{" "}
      {props.missing.map((m, i) => (
        <>
          {i ? ", " : ""}
          <code>{m}</code>
        </>
      ))}
    </p>
    <pre>{"cd worker\npnpm exec wrangler secret put <NAME>"}</pre>
    <p class="muted">
      4つ全て設定すると GitHub ログインが有効になります。
      <br />
      本番では設定必須です（ローカル開発のみ未設定で認証を省略できます）。
    </p>
  </BaseHtml>
);

// logout 後の着地ページ。frontping のセッションは破棄済みだが、GitHub にログインしたままだと
// SSO で再アクセスできてしまうため、GitHub 側の連携解除ページ（url）へ誘導する。
const LoggedOutPage = (props: { url: string }) => (
  <BaseHtml title="frontping" css={noticeCss}>
    <h1>GitHub 連携を解除してログアウトを完了してください</h1>
    <p>
      frontping のダッシュボードのセッションは破棄しました。ただし GitHub にログインしたままだと、
      連携が残っている限りこのダッシュボードへ再びアクセスできます。
    </p>
    <p>完全にログアウトするには、GitHub 側でこのアプリの連携を解除してください。</p>
    <p>
      <a class="btn" href={props.url}>
        GitHub で連携を解除する
      </a>
    </p>
    <p class="muted">
      連携を解除すると、次回アクセス時に GitHub の認可（許可）画面が再表示されます。
      <br />
      GitHub 自体のログインは解除されません（共有端末では GitHub 側もサインアウトしてください）。
    </p>
  </BaseHtml>
);

export const renderConfigError = (missing: string[]): string =>
  "<!doctype html>" + String(<ConfigErrorPage missing={missing} />);

export const renderLoggedOut = (url: string): string => "<!doctype html>" + String(<LoggedOutPage url={url} />);
