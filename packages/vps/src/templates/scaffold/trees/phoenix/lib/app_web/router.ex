defmodule AppWeb.Router do
  use Plug.Router

  plug :match
  plug :dispatch

  get "/" do
    send_resp(conn, 200, AppWeb.PageController.index_html())
  end

  get "/api/health" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{ok: true}))
  end

  match _ do
    send_resp(conn, 404, "Not found")
  end
end
