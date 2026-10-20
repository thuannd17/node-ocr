"""
Turn an exported recognition model (models/rec/<vN>/infer/inference.*) back into training weights,
so a new version can be fine-tuned from it when its training checkpoint was not kept.

  python src/scripts/rec_infer_to_train.py <train.yml> <infer_dir> <pretrained.pdparams> <out.pdparams>

The exported file has lost the parameter names (param_0, param_1, ...): they are saved sorted by the
names Paddle gave them when the model was built. The model is built here the way export_model.py
builds it, so it gets the same names; sorting them gives the order of the exported values. The parts
an exported model does not have (the SAR head, only used while training) come from <pretrained>.
Checked at the end: the rebuilt model gives the same output as the exported one.
"""
import os
import sys

import numpy as np
import paddle

PKG = os.path.join(sys.prefix, 'Lib', 'site-packages', 'paddleocr') if os.name == 'nt' else None
if not PKG or not os.path.isdir(PKG):
    import paddleocr
    PKG = os.path.dirname(paddleocr.__file__)
sys.path.insert(0, PKG)

from tools.program import load_config  # noqa: E402
from ppocr.modeling.architectures import build_model  # noqa: E402
from ppocr.postprocess import build_post_process  # noqa: E402


def main(cfg_path, infer_dir, pretrained_path, out_path):
    paddle.set_device('cpu')
    config = load_config(cfg_path)
    post = build_post_process(config['PostProcess'], config['Global'])
    char_num = len(post.character)
    head = config['Architecture']['Head']
    if head['name'] == 'MultiHead':
        head['out_channels_list'] = {'CTCLabelDecode': char_num, 'SARLabelDecode': char_num + 2, 'NRTRLabelDecode': char_num + 3}
    else:
        head['out_channels'] = char_num
    model = build_model(config['Architecture'])
    model.eval()
    sd = model.state_dict()

    exported = paddle.jit.load(os.path.join(infer_dir, 'inference'))
    values = exported.state_dict()
    values = [values[f'param_{i}'] for i in range(len(values))]
    used = [k for k in sd if not k.startswith('head.sar_head') and not k.startswith('head.gtc_head')]
    if len(used) != len(values):
        sys.exit(f'{len(used)} parameters in the model, {len(values)} in the exported one: not the same architecture')
    order = sorted(used, key=lambda k: sd[k].name)
    out = {k: v.numpy() for k, v in paddle.load(pretrained_path).items()}
    for k, v in zip(order, values):
        if list(sd[k].shape) != list(v.shape):
            sys.exit(f'shape of {k} {list(sd[k].shape)} != exported {list(v.shape)}: the order guess is wrong')
        out[k] = v.numpy()

    # check: same output as the exported model on a few random inputs
    model.set_state_dict({k: paddle.to_tensor(v) for k, v in out.items()})
    model.eval()
    worst = 0.0
    for seed in range(3):
        x = paddle.to_tensor(np.random.RandomState(seed).rand(1, 3, 48, 320).astype('float32'))
        a = model(x)
        a = a if isinstance(a, paddle.Tensor) else (a.get('ctc') if isinstance(a, dict) else a[0])
        b = exported(x)
        b = b if isinstance(b, paddle.Tensor) else b[0]
        worst = max(worst, float(paddle.abs(a - b).max()))
    if worst > 1e-4:
        sys.exit(f'the rebuilt model differs from the exported one (max diff {worst:.2e})')
    paddle.save({k: paddle.to_tensor(v) for k, v in out.items()}, out_path)
    print(f'ok: {len(values)} parameters from {infer_dir}, {len(out) - len(values)} from {pretrained_path}; max output diff {worst:.1e} -> {out_path}')


if __name__ == '__main__':
    main(*sys.argv[1:5])
