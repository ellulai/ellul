import Config

config :app, port: String.to_integer(System.get_env("PORT") || "4000")
