import { Layout, ErrorNote, inputClass, buttonClass } from "./Layout";

export function LoginPage(props: { mode: "signin" | "signup"; next: string; error?: string }) {
  const signup = props.mode === "signup";
  const other = signup
    ? `/login?next=${encodeURIComponent(props.next)}`
    : `/login?mode=signup&next=${encodeURIComponent(props.next)}`;
  return (
    <Layout title={signup ? "Create account" : "Sign in"}>
      <div class="max-w-sm mx-auto mt-16 bg-slate-900 rounded-xl p-6 shadow-xl">
        <h1 class="text-xl font-semibold text-center mb-4">{signup ? "Create account" : "Sign in"}</h1>
        <ErrorNote message={props.error} />
        <form method="post" action={signup ? "/signup" : "/login"} class="space-y-3">
          <input type="hidden" name="next" value={props.next} />
          {signup && <input name="name" type="text" placeholder="Name" class={inputClass} />}
          <input name="email" type="email" required placeholder="Email" class={inputClass} />
          <input name="password" type="password" required minlength={8} placeholder="Password" class={inputClass} />
          <button class={buttonClass}>Continue</button>
        </form>
        <a href={other} class="block mt-4 text-sm text-slate-400 hover:text-slate-200 text-center">
          {signup ? "Have an account? Sign in" : "Need an account? Sign up"}
        </a>
      </div>
    </Layout>
  );
}
