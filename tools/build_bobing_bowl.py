"""Generate matching, self-contained visual/collision GLBs and inspectable previews.

Run with Python + numpy + Pillow. Coordinates: metres, Y up, foot on Y=0.
No downloaded artwork or fonts are used.
"""
from pathlib import Path
import io
import json
import math
import struct
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'apps/web/public/models/bobing-bowl'
TAU = 2 * math.pi

# Cubic Bezier meridian, traversing the cavity, rounded lip, exterior and foot.
# Each end joins the next start exactly. Both axis endpoints are single vertices.
SPANS = [
    [(0,.024),(.020,.024),(.040,.024),(.058,.025)],
    [(.058,.025),(.080,.026),(.100,.032),(.118,.046)],
    [(.118,.046),(.144,.067),(.160,.099),(.171,.123)],
    [(.171,.123),(.174,.131),(.180,.133),(.180,.126)],
    [(.180,.126),(.176,.103),(.155,.063),(.133,.039)],
    [(.133,.039),(.115,.021),(.094,.012),(.074,.009)],
    [(.074,.009),(.069,.007),(.072,0),(.067,0)],
    [(.067,0),(.062,0),(.060,.001),(.060,.007)],
    [(.060,.007),(.047,.011),(.025,.010),(0,.010)],
]


def profile(samples):
    points = []
    for s, controls in enumerate(SPANS):
        a,b,c,d = np.array(controls)
        for i in range(samples):
            t = i / samples
            p = (1-t)**3*a + 3*(1-t)**2*t*b + 3*(1-t)*t*t*c + t**3*d
            tangent = 3*(1-t)**2*(b-a)+6*(1-t)*t*(c-b)+3*t*t*(d-c)
            points.append((p, tangent, (s+t)/len(SPANS)))
    points.append((np.array(SPANS[-1][-1]), np.array(SPANS[-1][-1])-SPANS[-1][-2], 1.0))
    return points


def lathe(samples, segments):
    positions, normals, uvs, rings, faces = [], [], [], [], []
    for (r,y), (dr,dy), v in profile(samples):
        ring = []
        if r == 0:
            ring.append(len(positions))
            positions.append([0,y,0]); normals.append([0,1 if v == 0 else -1,0]); uvs.append([.5,v])
        else:
            for j in range(segments):
                angle = j * TAU / segments
                co, si = math.cos(angle), math.sin(angle)
                ring.append(len(positions))
                positions.append([r*co,y,r*si])
                n = np.array([-dy*co,dr,-dy*si]); n /= np.linalg.norm(n)
                normals.append(n.tolist()); uvs.append([j/segments,v])
        rings.append(ring)
    for a,b in zip(rings,rings[1:]):
        for j in range(segments):
            k = (j+1) % segments
            if len(a) == 1:
                faces.append([a[0],b[k],b[j]])
            elif len(b) == 1:
                faces.append([a[j],a[k],b[0]])
            else:
                faces.extend([[a[j],a[k],b[j]],[a[k],b[k],b[j]]])
    return np.array(positions), np.array(normals), np.array(uvs), np.array(faces)


def textures(size=2048):
    mask = Image.new('L',(size,size),0)
    draw = ImageDraw.Draw(mask)
    def band(v, width):
        y = round(v*size); w = max(1,round(width*size))
        draw.rectangle((0,y-w//2,size,y+w//2),fill=255)
    # Inner lip paired gold hairlines, outer paired hairlines, lower exterior band.
    for v,w in [(0.304,.003),(0.316,.002),(0.375,.003),(0.389,.0015),(.555,.003),(.563,.0015),(.698,.003)]:
        band(v,w)
    # Repeating angular fret on the upper inner wall, constructed from original paths.
    for i in range(48):
        x = i*size/48; width = size/48
        y = .276*size; h = .018*size
        draw.line([(x,y+h),(x,y),(x+width*.8,y),(x+width*.8,y+h*.72),
                   (x+width*.28,y+h*.72),(x+width*.28,y+h*.30),
                   (x+width*.54,y+h*.30)], fill=255,width=3)
    band(.273,.0015); band(.298,.0015)
    # Concentric medallion on the broad cavity floor; radial petals appear after UV wrap.
    for v in [.070,.075,.157,.162]:
        band(v,.002)
    for i in range(16):
        cx = (i+.5)*size/16
        pts=[]
        for t in np.linspace(0,TAU,100):
            pts.append((cx+size/16*.40*math.sin(t), size*(.118+.032*math.cos(t))))
        draw.line(pts, fill=255,width=3)
    # Exterior cloud-like curling ornament in a broad, uncluttered band.
    for i in range(16):
        cx = (i+.5)*size/16; cy=.471*size
        pts=[]
        for t in np.linspace(0,3.5*math.pi,140):
            r=(1-t/(4*math.pi))*size*.019
            pts.append((cx+math.cos(t)*r,cy+math.sin(t)*r))
        draw.line(pts,fill=255,width=4)
        draw.line([(cx-size*.026,cy+size*.024),(cx,cy+size*.032),(cx+size*.026,cy+size*.024)],fill=255,width=3)
    alpha=np.array(mask,dtype=float)/255
    base=np.zeros((size,size,3),dtype=np.uint8)
    # PBR base colours are authored in sRGB; the GLB texture is interpreted as sRGB.
    red=np.array([156,17,25]); gold=np.array([226,177,75])
    base[:]=np.round(red[None,None,:]*(1-alpha[:,:,None])+gold[None,None,:]*alpha[:,:,None]).astype(np.uint8)
    mr=np.zeros_like(base); mr[:,:,0]=255
    mr[:,:,1]=np.round(255*(.20*(1-alpha)+.27*alpha)).astype(np.uint8)
    mr[:,:,2]=np.round(255*(.015*(1-alpha)+.78*alpha)).astype(np.uint8)
    def png(array):
        buffer=io.BytesIO(); Image.fromarray(array).save(buffer,format='PNG'); return buffer.getvalue()
    return png(base),png(mr),base


def glb(path, mesh, visual, maps=None):
    positions,normals,uvs,faces=mesh
    # Split only the texture seam in the visual mesh; collider stays welded.
    if visual:
        positions=positions.tolist(); normals=normals.tolist(); uvs=uvs.tolist(); faces=faces.copy()
        duplicates={}
        for face in faces:
            us=[uvs[int(i)][0] for i in face]
            if max(us)-min(us)>.5:
                for k,index in enumerate(face):
                    index=int(index)
                    if uvs[index][0]<.25:
                        if index not in duplicates:
                            duplicates[index]=len(positions)
                            positions.append(positions[index]); normals.append(normals[index]); uvs.append([uvs[index][0]+1,uvs[index][1]])
                        face[k]=duplicates[index]
        positions=np.array(positions); normals=np.array(normals); uvs=np.array(uvs)
    binary=bytearray(); views=[]; accessors=[]
    def append(data, target=None):
        while len(binary)%4: binary.append(0)
        view={'buffer':0,'byteOffset':len(binary),'byteLength':len(data)}
        if target: view['target']=target
        views.append(view); binary.extend(data); return len(views)-1
    def accessor(array, typ, component, target):
        a=np.asarray(array,dtype='<f4' if component==5126 else '<u4')
        obj={'bufferView':append(a.tobytes(),target),'componentType':component,'count':len(a),'type':typ}
        if typ=='VEC3': obj.update(min=a.min(axis=0).tolist(),max=a.max(axis=0).tolist())
        accessors.append(obj); return len(accessors)-1
    attributes={'POSITION':accessor(positions,'VEC3',5126,34962),'NORMAL':accessor(normals,'VEC3',5126,34962)}
    if visual: attributes['TEXCOORD_0']=accessor(uvs,'VEC2',5126,34962)
    indices=accessor(faces.flatten(),'SCALAR',5125,34963)
    material={'name':'Red glazed porcelain and gold enamel' if visual else 'Collision inspection blue',
              'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1] if visual else [.08,.4,.65,1], 'metallicFactor':1 if visual else 0,'roughnessFactor':1 if visual else .7}}
    doc={'asset':{'version':'2.0','generator':'bobing-online procedural bowl'},'scene':0,'scenes':[{'nodes':[0]}],
         'nodes':[{'name':'Bowl_Visual' if visual else 'Bowl_Collision','mesh':0,'extras':{'units':'metres','upAxis':'Y','origin':'centre of foot at table surface','purpose':'render' if visual else 'static concave collision; do not convex-hull whole bowl'}}],
         'meshes':[{'name':path.stem,'primitives':[{'attributes':attributes,'indices':indices,'material':0,'mode':4}]}],
         'materials':[material], 'bufferViews':views,'accessors':accessors}
    if visual:
        doc['images']=[{'bufferView':append(data),'mimeType':'image/png'} for data in maps]
        doc['samplers']=[{'magFilter':9729,'minFilter':9987,'wrapS':10497,'wrapT':33071}]
        doc['textures']=[{'sampler':0,'source':i} for i in range(2)]
        material['pbrMetallicRoughness'].update(baseColorTexture={'index':0},metallicRoughnessTexture={'index':1})
        material['extensions']={'KHR_materials_clearcoat':{'clearcoatFactor':.85,'clearcoatRoughnessFactor':.12}}
        doc['extensionsUsed']=['KHR_materials_clearcoat']
    while len(binary)%4: binary.append(0)
    doc['buffers']=[{'byteLength':len(binary)}]
    encoded=json.dumps(doc,separators=(',',':')).encode(); encoded+=b' '*((-len(encoded))%4)
    total=12+8+len(encoded)+8+len(binary)
    path.write_bytes(struct.pack('<4sII',b'glTF',2,total)+struct.pack('<I4s',len(encoded),b'JSON')+encoded+struct.pack('<I4s',len(binary),b'BIN\0')+binary)
    return {'file':path.name,'triangles':len(faces),'vertices':len(positions),'bytes':total}


def validate(mesh):
    p,n,uv,f=mesh
    edges=Counter(tuple(sorted((int(a),int(b)))) for face in f for a,b in zip(face,np.roll(face,-1)))
    cross=np.cross(p[f[:,1]]-p[f[:,0]],p[f[:,2]]-p[f[:,0]])
    area=np.linalg.norm(cross,axis=1)/2
    volume=float(np.sum(p[f[:,0]]*cross)/6)
    assert np.all(np.isfinite(p)) and np.all(area>1e-12)
    assert all(count==2 for count in edges.values()), 'Nonmanifold boundary'
    assert volume>0, 'Inside-out geometry'
    assert np.all(np.sum(cross*n[f].mean(axis=1),axis=1)>0), 'Inverted normals'
    return {'watertight':True,'zero_area_faces':0,'winding':'outward','volume_m3':volume,'bounds_m':[p.min(axis=0).tolist(),p.max(axis=0).tolist()]}


def preview(mesh, texture, filename, elevation=32, wire=False):
    """Orthographic CPU rasterizer with interpolated normals, UVs and depth."""
    p,n,uv,faces=mesh
    size=1000
    theta=math.radians(elevation)
    eye=np.array([0,math.sin(theta),math.cos(theta)])
    right=np.array([1,0,0]); up=np.cross(eye,right)
    target=np.array([0,.065,0]); rel=p-target
    coords=np.stack([rel@right,rel@up,rel@eye],axis=1)
    screen=np.stack([size/2+coords[:,0]*2350,size*.50-coords[:,1]*2350],axis=1)
    yy,xx=np.mgrid[0:size,0:size]
    bg=np.zeros((size,size,3),dtype=float); bg[:]=[30,27,29]
    shadow=np.exp(-((xx-500)/360)**2-((yy-745)/60)**2)*.55
    bg*=1-shadow[:,:,None]
    zbuf=np.full((size,size),-np.inf)
    lights=[(np.array([-.5,.85,.5]),1.0),(np.array([.7,.4,-.3]),.5)]
    for li,(v,strength) in enumerate(lights): lights[li]=(v/np.linalg.norm(v),strength)
    for face in faces:
        verts=p[face]
        if np.dot(np.cross(verts[1]-verts[0],verts[2]-verts[0]),eye)<=0: continue
        a,b,c=screen[face]
        lo=np.maximum(0,np.floor(np.min([a,b,c],axis=0)).astype(int)); hi=np.minimum(size-1,np.ceil(np.max([a,b,c],axis=0)).astype(int))
        if np.any(hi<lo): continue
        gx,gy=np.meshgrid(np.arange(lo[0],hi[0]+1)+.5,np.arange(lo[1],hi[1]+1)+.5)
        den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(den)<1e-9: continue
        w0=((b[1]-c[1])*(gx-c[0])+(c[0]-b[0])*(gy-c[1]))/den
        w1=((c[1]-a[1])*(gx-c[0])+(a[0]-c[0])*(gy-c[1]))/den
        w2=1-w0-w1
        depth=w0*coords[face[0],2]+w1*coords[face[1],2]+w2*coords[face[2],2]
        block=zbuf[lo[1]:hi[1]+1,lo[0]:hi[0]+1]
        selected=(w0>=0)&(w1>=0)&(w2>=0)&(depth>block)
        if not selected.any(): continue
        weights=np.stack([w0[selected],w1[selected],w2[selected]],axis=1)
        ns=weights@n[face]; ns/=np.linalg.norm(ns,axis=1)[:,None]
        if wire:
            color=np.tile([42.,128.,172.],(len(ns),1))
        else:
            texuv=uv[face].copy()
            if np.ptp(texuv[:,0])>.5: texuv[texuv[:,0]<.25,0]+=1
            texuv=weights@texuv
            u=(texuv[:,0]%1*(texture.shape[1]-1)).astype(int)
            v=(texuv[:,1]*(texture.shape[0]-1)).astype(int)
            color=texture[v,u].astype(float)
        illumination=np.full(len(ns),.32); spec=np.zeros(len(ns))
        for light,strength in lights:
            illumination+=np.maximum(ns@light,0)*strength*.60
            half=light+eye; half/=np.linalg.norm(half)
            spec+=np.maximum(ns@half,0)**100*strength*.55
        color=np.clip(color*illumination[:,None]+spec[:,None]*np.array([255,227,190]),0,255)
        if wire: color[np.min(weights,axis=1)<.075]=[155,221,237]
        block[selected]=depth[selected]
        bg[lo[1]:hi[1]+1,lo[0]:hi[0]+1][selected]=color
    im=Image.fromarray(bg.astype(np.uint8))
    label=ImageDraw.Draw(im)
    label.text((40,35),'BOBING / RED GLAZED PORCELAIN' if not wire else 'BOBING / COLLISION MESH',fill=(235,214,181),font_size=24)
    label.text((40,935),f'{len(faces):,} triangles  |  360 mm diameter  |  Y up',fill=(195,177,166),font_size=20)
    im.save(OUT/filename)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    visual=lathe(8,192); collision=lathe(3,48)
    base,mr,tex=textures()
    report={'visual':glb(OUT/'bowl-visual.glb',visual,True,[base,mr]),'collision':glb(OUT/'bowl-collision.glb',collision,False)}
    report['visual'].update(validate(visual)); report['collision'].update(validate(collision))
    # Quantify the actual collider's faceting against the fine meridian and azimuth.
    high=np.array([point for point,_,_ in profile(128)])
    low=np.array([point for point,_,_ in profile(3)])
    a=low[:-1]; d=low[1:]-a
    t=np.clip(np.sum((high[:,None]-a)*d,axis=2)/np.sum(d*d,axis=1),0,1)
    distances=np.linalg.norm(high[:,None]-(a+t[:,:,None]*d),axis=2)
    error=float(distances.min(axis=1).max()+.180*(1-math.cos(math.pi/48)))
    assert error<.0015
    report['collision']['surface_error_upper_bound_mm']=round(error*1000,3)
    preview(visual,tex,'preview-visual.png')
    preview(visual,tex,'preview-top.png',70)
    preview(collision,tex,'preview-collision.png',45,True)
    (OUT/'model-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    main()
