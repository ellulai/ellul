class ApplicationController < ActionController::Base
  def index
  end

  def health
    render json: { ok: true }
  end
end
