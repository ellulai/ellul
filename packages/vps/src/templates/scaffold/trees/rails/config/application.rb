require_relative "boot"
require "rails"
require "action_controller/railtie"
require "action_view/railtie"

module App
  class Application < Rails::Application
    config.load_defaults 7.1
    config.hosts.clear
  end
end
