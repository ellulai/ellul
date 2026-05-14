Rails.application.routes.draw do
  root "application#index"
  get "/api/health", to: "application#health"
end
