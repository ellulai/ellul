"""Gradio app for {{PROJECT_NAME}} — edit this file to start building."""
import os

import gradio as gr


def greet(name: str) -> str:
    return f"Hello, {name or 'world'}! — ellul"


demo = gr.Interface(fn=greet, inputs="text", outputs="text", title="{{PROJECT_NAME}}")

if __name__ == "__main__":
    demo.launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", 7860)),
    )
