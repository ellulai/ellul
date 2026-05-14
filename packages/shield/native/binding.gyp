{
  "targets": [
    {
      "target_name": "peercred",
      "sources": ["peercred.c"],
      "conditions": [
        ["OS=='linux'", {
          "defines": ["__linux__"]
        }],
        ["OS=='mac'", {
          "defines": ["__APPLE__"]
        }]
      ]
    }
  ]
}
