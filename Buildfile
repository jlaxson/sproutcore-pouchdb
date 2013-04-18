mode :debug do
  config :all,
    :combine_javascript => true,
    :combine_stylesheet => true
end

config :pouch_db, :required => [:sproutcore]