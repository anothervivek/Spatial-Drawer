import urllib.request
import urllib.parse
import json
import time
import os
import threading

TRIPO_BASE_URL = "https://api.tripo3d.ai/v2/openapi"

def upload_image(api_key, image_path):
    url = f"{TRIPO_BASE_URL}/upload"
    headers = {
        "Authorization": f"Bearer {api_key}"
    }
    
    # Boundary for multipart/form-data
    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    
    with open(image_path, "rb") as f:
        file_data = f.read()
        
    body = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"sketch.png\"\r\n"
        f"Content-Type: image/png\r\n\r\n"
    ).encode('utf-8') + file_data + f"\r\n--{boundary}--\r\n".encode('utf-8')
    
    headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    headers["Content-Length"] = str(len(body))
    
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            if res_data.get("code") == 0:
                return res_data["data"]["image_token"]
            else:
                print("[Tripo API] Upload error:", res_data)
                return None
    except Exception as e:
        print("[Tripo API] Upload exception:", e)
        return None

def create_task(api_key, image_token):
    url = f"{TRIPO_BASE_URL}/task"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    data = {
        "type": "image_to_model",
        "file": {
            "type": "png",
            "file_token": image_token
        }
    }
    req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            if res_data.get("code") == 0:
                return res_data["data"]["task_id"]
            else:
                print("[Tripo API] Create task error:", res_data)
                return None
    except Exception as e:
        print("[Tripo API] Create task exception:", e)
        return None

def poll_task(api_key, task_id):
    url = f"{TRIPO_BASE_URL}/task/{task_id}"
    headers = {
        "Authorization": f"Bearer {api_key}"
    }
    req = urllib.request.Request(url, headers=headers)
    
    while True:
        try:
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                if res_data.get("code") == 0:
                    status = res_data["data"]["status"]
                    if status == "success":
                        return res_data["data"]["result"]["model"]["url"]
                    elif status in ["failed", "cancelled", "timeout"]:
                        print("[Tripo API] Task failed:", status)
                        return None
                    else:
                        # running or queued
                        time.sleep(3)
                else:
                    print("[Tripo API] Poll error:", res_data)
                    return None
        except Exception as e:
            print("[Tripo API] Poll exception:", e)
            time.sleep(3)

def download_model(model_url, output_path):
    try:
        urllib.request.urlretrieve(model_url, output_path)
        return output_path
    except Exception as e:
        print("[Tripo API] Download error:", e)
        return None

def run_tripo_pipeline_async(api_key, image_path, callback):
    def worker():
        print("[Tripo API] Uploading sketch...")
        token = upload_image(api_key, image_path)
        if not token:
            callback(None)
            return
        
        print("[Tripo API] Creating AI generation task...")
        task_id = create_task(api_key, token)
        if not task_id:
            callback(None)
            return
            
        print("[Tripo API] Generating 3D model (this may take 30-60s)...")
        model_url = poll_task(api_key, task_id)
        if not model_url:
            callback(None)
            return
            
        print("[Tripo API] Downloading 3D model...")
        out_path = os.path.join(os.path.dirname(image_path), f"ai_gen_{int(time.time())}.glb")
        download_model(model_url, out_path)
        
        print(f"[Tripo API] Done! Saved to {out_path}")
        callback(out_path)

    t = threading.Thread(target=worker)
    t.daemon = True
    t.start()
