export function Layout(props: {
  title?: string;
  user?: { email: string; superadmin: boolean; admin: boolean };
  children?: any;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ?? "LP First Stats"}</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-950 text-slate-100 min-h-screen">
        {props.user ? (
          <nav class="max-w-4xl mx-auto flex items-center justify-between p-4 text-sm">
            <a href="/" class="font-semibold text-base text-slate-100">
              LP First Stats
            </a>
            <div class="flex items-center gap-4">
              <span class="text-slate-400">
                {props.user.email}
                {props.user.superadmin ? " · super admin" : ""}
              </span>
              {props.user.admin && (
                <a href="/admin" class="text-slate-400 hover:text-slate-200">
                  Admin
                </a>
              )}
              <form method="post" action="/signout">
                <button class="text-slate-400 hover:text-slate-200">Sign out</button>
              </form>
            </div>
          </nav>
        ) : null}
        <main class="max-w-4xl mx-auto p-4">{props.children}</main>
      </body>
    </html>
  );
}

export function ErrorNote(props: { message?: string }) {
  if (!props.message) return null;
  return <p class="text-red-400 text-sm mb-3">{props.message}</p>;
}

export const inputClass = "w-full rounded bg-slate-800 border border-slate-700 px-3 py-2";
export const buttonClass = "w-full rounded bg-indigo-600 hover:bg-indigo-500 py-2 font-medium";
export const cardClass = "bg-slate-900 rounded-xl p-5";
