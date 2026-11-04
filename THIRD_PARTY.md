# Third-party assets

## Image embeddings

Album Atlas bundles Google's ImageNet-trained MobileNet V2 1.0, 224 × 224 feature-vector graph, TensorFlow.js edition, version 1. Its output is a 1,280-dimensional feature vector. The graph and all three weight shards are unmodified. Album Atlas performs local preprocessing, similarity scoring, abstention and clustering. The runtime is TensorFlow.js 4.22.0, using the upstream `dist/tf.es2017.min.js` bundle. Both distributions use Apache License 2.0. Their license text is bundled alongside the assets. [Google model card](https://www.kaggle.com/models/google/mobilenet-v2/tfJs/100-224-feature-vector/1) · [Model archive](https://www.kaggle.com/api/v1/models/google/mobilenet-v2/tfJs/100-224-feature-vector/1/download) · [TensorFlow.js release](https://github.com/tensorflow/tfjs/releases/tag/tfjs-v4.22.0) · [Runtime package](https://registry.npmjs.org/@tensorflow/tfjs/-/tfjs-4.22.0.tgz) · [Apache License 2.0](vendor/APACHE-2.0.txt)

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `vendor/mobilenet/model.json` | 84,896 | `ecc27abdb8a229d3d26aed981164acbe4a3307ad906a57c81a0f196086f63d3c` |
| `vendor/mobilenet/group1-shard1of3.bin` | 4,194,304 | `4b4a2c2b6b39ffd895e73ce9bf83139bacd8fab81ddfd5878ac05f47109b11e7` |
| `vendor/mobilenet/group1-shard2of3.bin` | 4,194,304 | `8cb61cedfc032bdb0d3137487ded7bcd5d08b2c96e838804e1a42bde8b421e67` |
| `vendor/mobilenet/group1-shard3of3.bin` | 438,664 | `a6a78bd9318835b28cfb8abcdc2d092380ac7cbfcbdf201334bbd330ff7cccd1` |
| `vendor/tfjs/tf.es2017.min.js` | 1,105,894 | `a1f9e32fd9b373cf394905050cf0c8c66238b34925846c065db00d2a34d1c040` |

## Photo metadata, export and sample images

The EXIF reader is exifr by Mike Kovařík, distributed under the MIT License. ZIP export uses fflate by Arjun Barrett, distributed under the MIT License. The twelve demonstration photos have individual source, creator and license credits. [exifr license](vendor/exifr.LICENSE) · [fflate license](vendor/fflate.LICENSE) · [Photo credits](assets/DEMO-CREDITS.md)
