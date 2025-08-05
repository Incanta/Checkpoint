"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { signIn } from "next-auth/react";

export default function RegisterPage() {
  const [formData, setFormData] = useState({
    name: "",
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const registerMutation = api.auth.register.useMutation({
    onSuccess: async (_data) => {
      // Automatically sign in the user after registration
      const result = await signIn("credentials", {
        username: formData.username,
        password: formData.password,
        redirect: false,
      });

      if (result?.ok) {
        router.push("/");
      } else {
        setErrors({
          general:
            "Registration successful, but auto-login failed. Please try logging in manually.",
        });
      }
      setIsLoading(false);
    },
    onError: (error) => {
      setErrors({ general: error.message });
      setIsLoading(false);
    },
  });

  const checkUsername = api.auth.checkUsername.useQuery(
    { username: formData.username },
    {
      enabled: formData.username.length > 0,
      refetchOnWindowFocus: false,
    },
  );

  const checkEmail = api.auth.checkEmail.useQuery(
    { email: formData.email },
    {
      enabled: formData.email.length > 0 && formData.email.includes("@"),
      refetchOnWindowFocus: false,
    },
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));

    // Clear specific field errors when user starts typing
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: "" }));
    }
  };

  const validateForm = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = "Name is required";
    }

    if (!formData.username.trim()) {
      newErrors.username = "Username is required";
    } else if (formData.username.length < 1) {
      newErrors.username = "Username must be at least 1 character";
    } else if (checkUsername.data && !checkUsername.data.available) {
      newErrors.username = "Username is already taken";
    }

    if (!formData.email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(formData.email)) {
      newErrors.email = "Email is invalid";
    } else if (checkEmail.data && !checkEmail.data.available) {
      newErrors.email = "Email is already registered";
    }

    if (!formData.password) {
      newErrors.password = "Password is required";
    } else if (formData.password.length < 8) {
      newErrors.password = "Password must be at least 8 characters";
    }

    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsLoading(true);
    setErrors({});

    registerMutation.mutate({
      name: formData.name,
      username: formData.username,
      email: formData.email,
      password: formData.password,
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-white">
            Create your account
          </h2>
          <p className="mt-2 text-center text-sm text-gray-300">
            Or{" "}
            <Link
              href="/api/auth/signin"
              className="font-medium text-[hsl(280,100%,70%)] hover:text-[hsl(280,100%,80%)]"
            >
              sign in to your existing account
            </Link>
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4 rounded-md shadow-sm">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-gray-300"
              >
                Full Name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                required
                className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                placeholder="Enter your full name"
                value={formData.name}
                onChange={handleChange}
              />
              {errors.name && (
                <p className="mt-1 text-sm text-red-400">{errors.name}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-300"
              >
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                required
                className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                placeholder="Choose a username"
                value={formData.username}
                onChange={handleChange}
              />
              {checkUsername.isLoading && formData.username && (
                <p className="mt-1 text-sm text-gray-400">
                  Checking availability...
                </p>
              )}
              {checkUsername.data &&
                formData.username &&
                checkUsername.data.available && (
                  <p className="mt-1 text-sm text-green-400">
                    Username is available
                  </p>
                )}
              {errors.username && (
                <p className="mt-1 text-sm text-red-400">{errors.username}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-300"
              >
                Email Address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                placeholder="Enter your email address"
                value={formData.email}
                onChange={handleChange}
              />
              {checkEmail.isLoading &&
                formData.email &&
                formData.email.includes("@") && (
                  <p className="mt-1 text-sm text-gray-400">
                    Checking availability...
                  </p>
                )}
              {checkEmail.data &&
                formData.email &&
                checkEmail.data.available && (
                  <p className="mt-1 text-sm text-green-400">
                    Email is available
                  </p>
                )}
              {errors.email && (
                <p className="mt-1 text-sm text-red-400">{errors.email}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-300"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                placeholder="Create a password (min 8 characters)"
                value={formData.password}
                onChange={handleChange}
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-400">{errors.password}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-gray-300"
              >
                Confirm Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                className="relative block w-full appearance-none rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-white placeholder-gray-400 focus:z-10 focus:border-[hsl(280,100%,70%)] focus:outline-none focus:ring-[hsl(280,100%,70%)] sm:text-sm"
                placeholder="Confirm your password"
                value={formData.confirmPassword}
                onChange={handleChange}
              />
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-400">
                  {errors.confirmPassword}
                </p>
              )}
            </div>
          </div>

          {errors.general && (
            <div className="text-center text-sm text-red-400">
              {errors.general}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={
                isLoading || checkUsername.isLoading || checkEmail.isLoading
              }
              className="group relative flex w-full justify-center rounded-md border border-transparent bg-[hsl(280,100%,70%)] px-4 py-2 text-sm font-medium text-white hover:bg-[hsl(280,100%,60%)] focus:outline-none focus:ring-2 focus:ring-[hsl(280,100%,70%)] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? "Creating account..." : "Create Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
