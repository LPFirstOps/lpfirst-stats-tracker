import { Layout, ErrorNote, inputClass, buttonClass } from "./Layout";

export function AcceptInvitationPage(props: {
  id: string;
  email: string;
  mode: "signup" | "signin";
  error?: string;
}) {
  const signup = props.mode === "signup";
  const other = `/accept-invitation?id=${encodeURIComponent(props.id)}&email=${encodeURIComponent(props.email)}&mode=${signup ? "signin" : "signup"}`;
  return (
    <Layout title="Invitation">
      <div class="max-w-sm mx-auto mt-16 bg-slate-900 rounded-xl p-6 shadow-xl">
        <h1 class="text-xl font-semibold text-center mb-1">You're invited</h1>
        <p class="text-sm text-slate-400 text-center mb-4">
          {signup ? "Create an account to accept." : "Sign in to accept."}
        </p>
        <ErrorNote message={props.error} />
        <form method="post" action="/accept-invitation" class="space-y-3">
          <input type="hidden" name="id" value={props.id} />
          <input type="hidden" name="mode" value={props.mode} />
          {signup && <input name="name" type="text" placeholder="Name" class={inputClass} />}
          <input name="email" type="email" required placeholder="Email" value={props.email} class={inputClass} />
          <input name="password" type="password" required minlength={8} placeholder="Password" class={inputClass} />
          <button class={buttonClass}>Accept invitation</button>
        </form>
        <a href={other} class="block mt-4 text-sm text-slate-400 hover:text-slate-200 text-center">
          {signup ? "Already have an account? Sign in" : "Need an account? Sign up"}
        </a>
      </div>
    </Layout>
  );
}
