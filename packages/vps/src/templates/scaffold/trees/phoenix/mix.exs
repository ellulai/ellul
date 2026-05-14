defmodule App.MixProject do
  use Mix.Project

  def project do
    [
      app: :app,
      version: "0.1.0",
      elixir: "~> 1.14",
      deps: deps()
    ]
  end

  def application do
    [mod: {App.Application, []}, extra_applications: [:logger]]
  end

  defp deps do
    [
      {:plug_cowboy, "~> 2.6.0"},
      {:jason, "~> 1.2"}
    ]
  end
end
