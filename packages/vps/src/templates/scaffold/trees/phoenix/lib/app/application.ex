defmodule App.Application do
  use Application

  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT") || "4000")

    children = [
      {Plug.Cowboy, scheme: :http, plug: AppWeb.Router, options: [port: port, ip: {0, 0, 0, 0}]}
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: App.Supervisor)
  end
end
