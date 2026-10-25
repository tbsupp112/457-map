"""Convert the October 2026 GIS intake. Requires rasterio, fiona, shapely, pyproj, Pillow.

Usage: python tools/import_gis.py ../_local/gis-2026-10-24/Maps
Raw GIS inputs and GIS dependencies belong outside the publish folder.
"""
import argparse
import json
import sys
from pathlib import Path
sys.dont_write_bytecode = True
import fiona
import numpy as np
import rasterio
from rasterio.warp import calculate_default_transform, reproject, transform_bounds, Resampling
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

def save(output, name, features):
    target = output / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({'type':'FeatureCollection','features':features}, separators=(',',':'))+'\n', encoding='utf-8')

def feature(geom, props):
    return {'type':'Feature','geometry':geom,'properties':props}

def convert(source, output):
    for stem in ['soils','topo']:
        with fiona.open(source/f'{stem}.shp') as src:
            project=Transformer.from_crs(src.crs,'EPSG:4326',always_xy=True).transform
            features=[]
            for i,f in enumerate(src):
                p=dict(f['properties']); geom=shape(f['geometry'])
                if stem=='topo':
                    # Sub-meter simplification removes redundant vertices without moving contour levels.
                    geom=geom.simplify(.2,preserve_topology=True)
                    props={'id':f'contour-{i+1}','name':f"{p['Contour']:g} m contour",'elevation':p['Contour'],'elevation_unit':'m'}
                else:
                    props={'id':f'soil-{i+1}','name':f"Soil map unit {p['MUSYM']}",'symbol':p['MUSYM'],'map_unit_key':p['MUKEY'],'survey_area':p['AREASYMBOL']}
                features.append(feature(mapping(transform(project,geom)),props))
            save(output, 'contours.geojson' if stem=='topo' else 'soils.geojson',features)
    palettes={
        'slope':(['#ffffcc','#c2e699','#78c679','#31a354','#fd8d3c','#bd0026'],['0–5°','5–10°','10–15°','15–25°','25–45°','45°+']),
        'aspect':(['#4575b4','#74add1','#abd9e9','#fee090','#fdae61','#f46d43','#d73027','#8073ac'],['N','NE','E','SE','S','SW','W','NW'])}
    for stem,(colors,labels) in palettes.items():
        with rasterio.open(source/stem) as src:
            affine,w,h=calculate_default_transform(src.crs,'EPSG:3857',src.width,src.height,*src.bounds)
            values=np.full((h,w),-9999,dtype='float32')
            reproject(rasterio.band(src,1), values,src_transform=src.transform,src_crs=src.crs,dst_transform=affine,dst_crs='EPSG:3857',src_nodata=src.nodata,dst_nodata=-9999,resampling=Resampling.nearest)
            valid=(values>=0)&(values<=90 if stem=='slope' else values<=360)
            classes=np.digitize(values,[5,10,15,25,45]) if stem=='slope' else np.floor(((values+22.5)%360)/45).astype(int)
            rgba=np.zeros((h,w,4),dtype='uint8')
            for i,c in enumerate(colors):
                rgba[valid&(classes==i)]=[int(c[j:j+2],16) for j in (1,3,5)]+[255]
            Image.fromarray(rgba).save(output/f'{stem}.png',optimize=True)
            west,south,east,north=transform_bounds('EPSG:3857','EPSG:4326',*rasterio.transform.array_bounds(h,w,affine))
            props={'id':stem,'name':'Slope steepness' if stem=='slope' else 'Slope direction (aspect)','image_path':f'data/terrain/{stem}.png','bounds':[[south,west],[north,east]],'units':'degrees' if stem=='slope' else 'degrees clockwise from north','legend':[{'label':label,'color':c} for label,c in zip(labels,colors)]}
            save(output, f'{stem}.geojson',[feature({'type':'Polygon','coordinates':[[[west,south],[east,south],[east,north],[west,north],[west,south]]]},props)])

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('--output-dir',type=Path,default=ROOT.parent/'_local/_candidates/gis-2026-10-24')
    args=parser.parse_args()
    convert(args.source,args.output_dir)
