"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { loginSchema, type LoginInput } from "@hybrid/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "demo@example.com", password: "password" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    // BFF プロキシ経由。成功すると httpOnly cookie がセットされる（token はJSに渡らない）。
    const res = await api.auth.login.$post({ json: values });
    if (!res.ok) {
      setError("メールアドレスまたはパスワードが違います");
      return;
    }
    router.push("/todos");
    router.refresh();
  });

  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-6 text-2xl font-bold">ログイン</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Input type="email" placeholder="メール" {...register("email")} />
          {errors.email && (
            <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>
          )}
        </div>
        <div>
          <Input
            type="password"
            placeholder="パスワード"
            {...register("password")}
          />
          {errors.password && (
            <p className="mt-1 text-xs text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? "送信中..." : "ログイン"}
        </Button>
      </form>
      <p className="mt-4 text-xs text-neutral-500">
        seed 済みアカウント: demo@example.com / password
      </p>
    </main>
  );
}
