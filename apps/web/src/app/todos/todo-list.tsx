"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createTodoSchema, type CreateTodoInput } from "@hybrid/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Todo = {
  id: string;
  title: string;
  done: boolean;
  userId: string;
  createdAt: string;
};

export function TodoList() {
  const router = useRouter();
  const qc = useQueryClient();

  const todos = useQuery({
    queryKey: ["todos"],
    queryFn: async (): Promise<Todo[]> => {
      const res = await api.todos.$get();
      if (res.status === 401) {
        router.push("/login");
        return [];
      }
      if (!res.ok) throw new Error("取得に失敗しました");
      return (await res.json()) as Todo[];
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["todos"] });

  const create = useMutation({
    mutationFn: async (input: CreateTodoInput) => {
      const res = await api.todos.$post({ json: input });
      if (!res.ok) throw new Error("作成に失敗しました");
    },
    onSuccess: invalidate,
  });

  const toggle = useMutation({
    mutationFn: async (input: { id: string; done: boolean }) => {
      await api.todos[":id"].$patch({
        param: { id: input.id },
        json: { done: input.done },
      });
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.todos[":id"].$delete({ param: { id } });
    },
    onSuccess: invalidate,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateTodoInput>({
    resolver: zodResolver(createTodoSchema),
    defaultValues: { title: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    await create.mutateAsync(values);
    reset();
  });

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  };

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="flex-1">
          <Input placeholder="新しい Todo" {...register("title")} />
          {errors.title && (
            <p className="mt-1 text-xs text-red-600">{errors.title.message}</p>
          )}
        </div>
        <Button type="submit" disabled={create.isPending}>
          追加
        </Button>
      </form>

      {todos.isLoading ? (
        <p className="text-sm text-neutral-500">読み込み中...</p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {todos.data?.length === 0 && (
            <li className="p-4 text-sm text-neutral-500">Todo はありません</li>
          )}
          {todos.data?.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 p-3">
              <input
                type="checkbox"
                checked={todo.done}
                onChange={(e) =>
                  toggle.mutate({ id: todo.id, done: e.target.checked })
                }
                aria-label={`${todo.title} を完了にする`}
              />
              <span
                className={
                  todo.done ? "flex-1 text-neutral-400 line-through" : "flex-1"
                }
              >
                {todo.title}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove.mutate(todo.id)}
              >
                削除
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button variant="outline" size="sm" onClick={logout}>
        ログアウト
      </Button>
    </div>
  );
}
