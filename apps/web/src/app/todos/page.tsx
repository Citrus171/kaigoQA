import { TodoList } from "./todo-list";

export default function TodosPage() {
  // 認証ガードはクライアント側（TodoList が 401 を受けたら /login へ）。
  return (
    <main className="mx-auto mt-16 max-w-xl px-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Todo</h1>
      </header>
      <TodoList />
    </main>
  );
}
