import { Loading } from "@/components/workspace/skeleton";

/** Shown at once on navigation inside the workspace while the next screen renders. */
export default function WorkspaceLoading() {
  return (
    <section className="panel">
      <Loading />
    </section>
  );
}
