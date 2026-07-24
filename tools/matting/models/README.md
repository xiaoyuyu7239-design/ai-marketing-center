# UltraFace model

`version-RFB-320.onnx` is the ONNX Model Zoo UltraFace detector used only for local
face-presence screening. It does not perform identity recognition.

- Source: `onnxmodelzoo/version-RFB-320`, commit `6fd293d22b523ec88959f104b8eef5395e3adfbc`
- Download: `https://huggingface.co/onnxmodelzoo/version-RFB-320`
- SHA-256: `34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017`
- License: Apache-2.0 (model repository metadata)

The runtime verifies the model digest before every detector process starts. If the
model is absent or its digest differs, the caller must fail closed to manual review.
